// Mock data for the app prototype. Shared runtime types live in contracts.
import type {
  BootstrapState,
  IngestState,
  JourneyPhase,
  OntologyFileNode,
  OntologyMessage,
  OntologyProject,
  OntologySession,
  PhasePayload,
  ReviewFile,
  ReviewState,
  VerifyState,
} from "@/contracts/ontology";

export type Project = OntologyProject;
export type Session = OntologySession;
export type OntologyPage = OntologyFileNode;
export type ChatMessage = OntologyMessage;
export type { BootstrapState, IngestState, JourneyPhase, PhasePayload, ReviewFile, ReviewState, VerifyState };

export type ResourceType = "repo" | "doc" | "api" | "file" | "image" | "spreadsheet" | "website";
export type ResourceStatus = "unused" | "linked" | "outdated";
export interface Resource { id: string; name: string; type: ResourceType; description: string; lastSynced: string; status: ResourceStatus; linkedOntologies: string[]; size?: number; source?: "upload" | "resource-library" | "bitbucket"; fileSize?: string; folder?: string; createdAt?: string; updatedAt?: string; uploaderUserId?: string; uploaderTenantId?: string; shared?: boolean; bitbucket?: { workspace: string; repoSlug: string; defaultBranch: string }; }
export interface ResourceFolder { id: string; name: string; createdAt: string; updatedAt?: string; parentId?: string; }

export const mockFolders: ResourceFolder[] = [
  { id: "f1", name: "order-management", createdAt: "2026-06-20" },
  { id: "f2", name: "infra-docs", createdAt: "2026-06-18" },
  { id: "f3", name: "marketplace-prds", createdAt: "2026-06-15" },
];

export const mockResources: Resource[] = [
  { id: "r1", name: "AP_Order_Management.xlsx", type: "spreadsheet", description: "亚太区备件订单数据源表", lastSynced: "2h ago", status: "linked", linkedOntologies: ["AP Order Management"], fileSize: "4.7 MB", folder: "f1" },
  { id: "r2", name: "Auto_Flow_Trigger.docx", type: "doc", description: "自动化工作流触发规则文档", lastSynced: "2h ago", status: "linked", linkedOntologies: ["AP Order Management", "Marketplace"], fileSize: "1.2 MB", folder: "f1" },
  { id: "r3", name: "Order_API_Spec.yaml", type: "api", description: "OrderService OpenAPI 3.0 spec", lastSynced: "1d ago", status: "linked", linkedOntologies: ["Marketplace"] },
];
// --- Static mock data ---

export const mockProjects: Project[] = [
  {
    id: "proj-marketplace",
    name: "Marketplace",
    description: "AI Marketplace 业务知识库，覆盖订单、商品、用户等核心系统",
    pageCount: 47,
    lastUpdated: "2026-06-14",
    status: "active",
    color: "#8ab4f8",
    emoji: "\u{1F6D2}",
  },
  {
    id: "proj-infra",
    name: "Infra Docs",
    description: "基础设施与部署文档，包含 K8s、CI/CD、监控告警等",
    pageCount: 12,
    lastUpdated: "2026-06-10",
    status: "active",
    color: "#81c995",
    emoji: "\u{1F528}",
  },
  {
    id: "proj-onboarding",
    name: "Onboarding",
    description: "新人入职知识库，涵盖团队规范、开发环境搭建、权限申请流程",
    pageCount: 8,
    lastUpdated: "2026-06-08",
    status: "active",
    color: "#f6aea9",
    emoji: "\u{1F331}",
  },
  {
    id: "proj-data-platform",
    name: "Data Platform",
    description: "数据平台架构文档，包括数据仓库、ETL 管道、BI 报表体系",
    pageCount: 23,
    lastUpdated: "2026-06-12",
    status: "active",
    color: "#c58af9",
    emoji: "\u{1F4CA}",
  },
  {
    id: "proj-security",
    name: "Security",
    description: "安全合规知识库，覆盖 IAM 策略、数据加密、审计日志、漏洞管理",
    pageCount: 15,
    lastUpdated: "2026-06-05",
    status: "active",
    color: "#fdd663",
    emoji: "\u{1F512}",
  },
  {
    id: "proj-mobile",
    name: "Mobile App",
    description: "移动端应用技术文档，React Native 架构、发版流程、热更新机制",
    pageCount: 6,
    lastUpdated: "2026-06-01",
    status: "active",
    color: "#ff8a65",
    emoji: "\u{1F4F1}",
  },
];

export const mockSessions: Session[] = [
  { id: "s1", projectId: "proj-marketplace", projectName: "Marketplace", projectColor: "#8ab4f8", preview: "整理订单和商品服务的接口文档", updatedAt: Date.now() - 1800000, timeAgo: "2h ago" },
  { id: "s2", projectId: "proj-infra", projectName: "Infra Docs", projectColor: "#81c995", preview: "梳理 K8s 集群部署流程", updatedAt: Date.now() - 3600000, timeAgo: "1d ago" },
  { id: "s3", projectId: "proj-marketplace", projectName: "Marketplace", projectColor: "#8ab4f8", preview: "同步代码仓库最新变更", updatedAt: Date.now() - 86400000, timeAgo: "3d ago" },
];

export const mockOntologyTree: OntologyPage[] = [
  { name: "index.md", path: "index.md", type: "file" },
  { name: "overview.md", path: "overview.md", type: "file" },
  {
    name: "business_objects",
    path: "business_objects",
    type: "dir",
    children: [
      { name: "Order.md", path: "business_objects/Order.md", type: "file" },
      { name: "Product.md", path: "business_objects/Product.md", type: "file" },
      { name: "User.md", path: "business_objects/User.md", type: "file" },
    ],
  },
  {
    name: "interfaces",
    path: "interfaces",
    type: "dir",
    children: [
      { name: "OrderAPI.md", path: "interfaces/OrderAPI.md", type: "file" },
      { name: "ProductAPI.md", path: "interfaces/ProductAPI.md", type: "file" },
    ],
  },
  {
    name: "business_flows",
    path: "business_flows",
    type: "dir",
    children: [
      { name: "Checkout.md", path: "business_flows/Checkout.md", type: "file" },
      { name: "Refund.md", path: "business_flows/Refund.md", type: "file" },
    ],
  },
  {
    name: "sources",
    path: "sources",
    type: "dir",
    children: [
      { name: "order-service.md", path: "sources/order-service.md", type: "file" },
      { name: "product-service.md", path: "sources/product-service.md", type: "file" },
    ],
  },
];

export const mockOntologyContent: Record<string, string> = {
  "index.md": `---
title: "Wiki Index"
type: index
---

# Wiki Index

## Overview
- [Overview](overview.md) — 全局综合概述

## Business Objects
- [Order](business_objects/Order.md) — 订单核心模型
- [Product](business_objects/Product.md) — 商品模型
- [User](business_objects/User.md) — 用户模型

## Interfaces
- [OrderAPI](interfaces/OrderAPI.md) — 订单服务接口
- [ProductAPI](interfaces/ProductAPI.md) — 商品服务接口

## Business Flows
- [Checkout](business_flows/Checkout.md) — 下单结账流程
- [Refund](business_flows/Refund.md) — 退款流程
`,
  "business_objects/Order.md": `---
title: "Order"
type: business_objects
tags: [order, core]
last_updated: 2026-06-14
---

## Summary
订单是 Marketplace 的核心业务对象，记录买家从下单到完成的完整交易生命周期。

## Key Claims
- 订单状态包括: pending, paid, shipped, delivered, completed, refunded
- 每个订单关联一个买家和一个或多个卖家
- 订单金额支持多币种

## Connections
- [[Product]] — 订单包含商品明细
- [[Checkout]] — 下单流程创建订单
- [[Refund]] — 退款流程修改订单状态
`,
  "overview.md": `---
title: "Overview"
type: overview
last_updated: 2026-06-14
---

## Summary
本知识覆盖 AI Marketplace 的核心业务逻辑，包括订单、商品、用户等业务对象及其交互流程。

## Key Themes
- 订单生命周期管理
- 商品上架与搜索
- 多角色权限体系
- 支付与结算
`,
};

export const mockQueryResponse = `根据知识中的信息，订单状态流转如下：

1. **pending** — 用户提交订单，等待支付
2. **paid** — 支付成功，等待卖家发货
3. **shipped** — 卖家已发货，物流运输中
4. **delivered** — 买家确认收货
5. **completed** — 交易完成，进入售后期
6. **refunded** — 退款完成（可从 paid/shipped/delivered 触发）

相关页面：
- [[Order]] — 订单核心模型
- [[Checkout]] — 下单结账流程
- [[Refund]] — 退款流程`;

// --- Journey mock conversation ---
// This simulates the full bootstrap → ingest → verify → ready flow.
// Each message triggers UI state changes in the right panel.

export const mockSessionMessages: Record<string, { role: "user" | "agent"; content: string }[]> = {
  s1: [
    { role: "user", content: "帮我整理一下订单服务和商品服务的接口文档" },
    { role: "agent", content: "好的，我来帮你梳理。根据知识中的信息：\n\n**订单服务 (OrderAPI)**\n- POST /orders — 创建订单\n- GET /orders/:id — 查询订单详情\n- PUT /orders/:id/status — 更新订单状态\n- POST /orders/:id/cancel — 取消订单\n\n**商品服务 (ProductAPI)**\n- GET /products — 商品列表（支持分页、筛选）\n- GET /products/:id — 商品详情\n- POST /products — 创建商品\n- PUT /products/:id — 更新商品信息\n\n需要我进一步展开某个接口的详细参数吗？" },
  ],
  s2: [
    { role: "user", content: "帮我梳理一下 K8s 集群的部署流程" },
    { role: "agent", content: "根据 Infra Docs 的知识库，K8s 集群部署流程如下：\n\n1. **环境准备** — 确认节点规格、网络配置\n2. **集群创建** — 通过 Terraform 创建 EKS/ACK 集群\n3. **基础组件部署** — Ingress Controller、Cert-Manager、External-DNS\n4. **监控告警** — Prometheus + Grafana 部署\n5. **应用部署** — Helm Chart 滚动发布\n\n需要我展开某个步骤的具体操作吗？" },
  ],
  s3: [
    { role: "user", content: "同步一下代码仓库最新的变更到知识" },
    { role: "agent", content: "已扫描代码仓库，发现 3 处新变更：\n\n1. `order-service` 新增了批量取消接口\n2. `product-service` 增加了库存预占逻辑\n3. `payment-service` 更新了超时重试策略\n\n已自动更新对应的知识页面。" },
  ],
};

// --- Journey mock conversation ---
// This simulates the full bootstrap → ingest → verify → ready flow.
// Each message triggers UI state changes in the right panel.

export const journeyConversation: ChatMessage[] = [
  // === Phase 1: Bootstrap ===
  // Step 1: Ask what user wants to build
  {
    role: "agent",
    content: "欢迎！让我们一起构建你的 Wiki。首先，它覆盖什么领域？请简单描述一下用途。",
    phaseTransition: "bootstrap",
    phaseData: { type: "bootstrap", state: { step: 1, totalSteps: 4, name: null, description: null, pageTypes: [], sources: [] } },
  },
  // User describes (trigger: any message)
  {
    role: "user",
    content: "我要整理关于备件订单的一些处理，一些特殊场景相关的内容。",
  },
  // Agent asks for file upload — panel does NOT open yet
  {
    role: "agent",
    content: "了解，这是一个运营场景知识库。为了帮你生成最合适的结构，我需要先看一下你的原始材料。\n\n请通过对话框上传相关文件（文档、表格、PRD 等），或者从 Resource Library 中引用已有资源。\n\n上传后，我会在右侧面板为你生成结构预览。",
  },
  // User uploads files (trigger: any message — simulates upload)
  {
    role: "user",
    content: "已上传 AP_Order_Management.xlsx 和 Auto_Flow_Trigger.docx",
  },
  // Agent analyzes and proposes schema — panel opens here
  {
    role: "agent",
    content: "好，我已经分析了你的材料。这是联想亚太区 IDG 备件订单管理的运营知识库，核心内容包括：\n\n- 多个数据源表（MSD_WO、SSOC、ETA Report、PUDO 配置等）\n- 自动化工作流触发场景\n- 按 Region 分发的邮件规则和闭环条件\n- 邮件模板\n\n这明确属于**运营手册**类型。我的推荐结构已在右侧面板展示，你可以直接在面板上修改名称和分类。\n\n确认结构后我们继续导入。",
    steps: [
      { icon: "📄", text: "Read AP_Order_Management.xlsx" },
      { icon: "📄", text: "Read Auto_Flow_Trigger.docx" },
      { icon: "🔍", text: "Analyzing document structure" },
      { icon: "💡", text: "Identified archetype: Operational Playbook" },
      { icon: "✨", text: "Generating schema recommendation" },
    ],
    phaseData: {
      type: "bootstrap",
      state: {
        step: 2,
        name: "AP Order Management",
        description: "联想亚太区 IDG 备件订单运营知识库",
        pageTypes: [
          { name: "data_tables", description: "数据表定义：字段级说明、类型、约束、跨表关联", confirmed: false },
          { name: "scenarios", description: "执行场景：触发条件、判断逻辑、处理步骤、闭环机制", confirmed: false },
          { name: "rules", description: "运营规则：路由、升级、SLA、优先级判断", confirmed: false },
          { name: "templates", description: "执行模板：邮件模板，含字段占位符", confirmed: false },
          { name: "terminology", description: "术语映射：系统术语 → 业务含义对照", confirmed: false },
        ],
      },
    },
  },
  // User confirms (trigger: any message)
  {
    role: "user",
    content: "结构没问题，确认。",
  },
  // Agent confirms and proceeds directly to ingest
  {
    role: "agent",
    content: "结构已确认，开始导入你上传的文件。",
    phaseData: {
      type: "bootstrap",
      state: {
        step: 3,
        pageTypes: [
          { name: "data_tables", description: "数据表定义：字段级说明、类型、约束、跨表关联", confirmed: true },
          { name: "scenarios", description: "执行场景：触发条件、判断逻辑、处理步骤、闭环机制", confirmed: true },
          { name: "rules", description: "运营规则：路由、升级、SLA、优先级判断", confirmed: true },
          { name: "templates", description: "执行模板：邮件模板，含字段占位符", confirmed: true },
          { name: "terminology", description: "术语映射：系统术语 → 业务含义对照", confirmed: true },
        ],
      },
    },
  },
  // === Phase 2: Ingest ===
  {
    role: "agent",
    content: "结构已确认，开始导入。",
    steps: [
      { icon: "📋", text: "Generated ingest plan: 5 batches, 18 files" },
      { icon: "▶", text: "Starting batch execution" },
    ],
    phaseTransition: "ingest",
    phaseData: {
      type: "ingest",
      state: {
        totalBatches: 5,
        completedBatches: 0,
        progress: 0,
        batches: [
          { id: "batch-1", label: "Data Tables", description: "数据表定义 — MSD_WO, SSOC, ETA Report, PUDO, PN_IB", fileCount: 5, status: "processing" },
          { id: "batch-2", label: "Scenarios & Flows", description: "执行场景 — Wrong Order, WO Stuck, WO Abnormal, ETA Query", fileCount: 4, status: "pending" },
          { id: "batch-3", label: "Rules & Routing", description: "运营规则 — Region Routing, SLA Escalation, Closure, Trigger", fileCount: 4, status: "pending" },
          { id: "batch-4", label: "Templates", description: "邮件模板 — Wrong Order, ETA, WO Stuck", fileCount: 3, status: "pending" },
          { id: "batch-5", label: "Terminology & Index", description: "术语表 + 索引 + 概览", fileCount: 2, status: "pending" },
        ],
      },
    },
  },
  {
    role: "agent",
    content: "",
    phaseData: {
      type: "ingest",
      state: {
        totalBatches: 5,
        completedBatches: 1,
        progress: 20,
        batches: [
          { id: "batch-1", label: "Data Tables", description: "数据表定义 — MSD_WO, SSOC, ETA Report, PUDO, PN_IB", fileCount: 5, status: "success" },
          { id: "batch-2", label: "Scenarios & Flows", description: "执行场景 — Wrong Order, WO Stuck, WO Abnormal, ETA Query", fileCount: 4, status: "processing" },
          { id: "batch-3", label: "Rules & Routing", description: "运营规则 — Region Routing, SLA Escalation, Closure, Trigger", fileCount: 4, status: "pending" },
          { id: "batch-4", label: "Templates", description: "邮件模板 — Wrong Order, ETA, WO Stuck", fileCount: 3, status: "pending" },
          { id: "batch-5", label: "Terminology & Index", description: "术语表 + 索引 + 概览", fileCount: 2, status: "pending" },
        ],
      },
    },
  },
  {
    role: "agent",
    content: "product-service 完成。继续处理 user-service...",
    phaseData: {
      type: "ingest",
      state: {
        files: [
          { path: "raw/src/order-service", status: "done" },
          { path: "raw/src/product-service", status: "done" },
          { path: "raw/src/user-service", status: "processing" },
          { path: "raw/src/payment-service", status: "pending" },
          { path: "raw/prds/checkout-prd.md", status: "pending" },
          { path: "raw/prds/refund-prd.md", status: "pending" },
        ],
        generatedPages: [
          "wiki/business_objects/Order.md",
          "wiki/interfaces/OrderAPI.md",
          "wiki/sources/order-service.md",
          "wiki/business_objects/Product.md",
          "wiki/interfaces/ProductAPI.md",
          "wiki/sources/product-service.md",
        ],
        progress: 33,
      },
    },
  },
  {
    role: "agent",
    content: "user-service 和 payment-service 处理完成。开始处理 PRD 文档...",
    phaseData: {
      type: "ingest",
      state: {
        files: [
          { path: "raw/src/order-service", status: "done" },
          { path: "raw/src/product-service", status: "done" },
          { path: "raw/src/user-service", status: "done" },
          { path: "raw/src/payment-service", status: "done" },
          { path: "raw/prds/checkout-prd.md", status: "processing" },
          { path: "raw/prds/refund-prd.md", status: "pending" },
        ],
        generatedPages: [
          "wiki/business_objects/Order.md",
          "wiki/interfaces/OrderAPI.md",
          "wiki/sources/order-service.md",
          "wiki/business_objects/Product.md",
          "wiki/interfaces/ProductAPI.md",
          "wiki/sources/product-service.md",
          "wiki/business_objects/User.md",
          "wiki/sources/user-service.md",
          "wiki/business_objects/Payment.md",
          "wiki/interfaces/PaymentAPI.md",
          "wiki/sources/payment-service.md",
        ],
        progress: 67,
      },
    },
  },
  {
    role: "agent",
    content: "",
    phaseData: {
      type: "ingest",
      state: {
        totalBatches: 5,
        completedBatches: 4,
        progress: 80,
        batches: [
          { id: "batch-1", label: "Data Tables", description: "数据表定义 — MSD_WO, SSOC, ETA Report, PUDO, PN_IB", fileCount: 5, status: "success" },
          { id: "batch-2", label: "Scenarios & Flows", description: "执行场景 — Wrong Order, WO Stuck, WO Abnormal, ETA Query", fileCount: 4, status: "success" },
          { id: "batch-3", label: "Rules & Routing", description: "运营规则 — Region Routing, SLA Escalation, Closure, Trigger", fileCount: 4, status: "success" },
          { id: "batch-4", label: "Templates", description: "邮件模板 — Wrong Order, ETA, WO Stuck", fileCount: 3, status: "success" },
          { id: "batch-5", label: "Terminology & Index", description: "术语表 + 索引 + 概览", fileCount: 2, status: "processing" },
        ],
      },
    },
  },
  {
    role: "agent",
    content: "",
    phaseData: {
      type: "ingest",
      state: {
        totalBatches: 5,
        completedBatches: 5,
        progress: 100,
        batches: [
          { id: "batch-1", label: "Data Tables", description: "数据表定义 — MSD_WO, SSOC, ETA Report, PUDO, PN_IB", fileCount: 5, status: "success" },
          { id: "batch-2", label: "Scenarios & Flows", description: "执行场景 — Wrong Order, WO Stuck, WO Abnormal, ETA Query", fileCount: 4, status: "success" },
          { id: "batch-3", label: "Rules & Routing", description: "运营规则 — Region Routing, SLA Escalation, Closure, Trigger", fileCount: 4, status: "success" },
          { id: "batch-4", label: "Templates", description: "邮件模板 — Wrong Order, ETA, WO Stuck", fileCount: 3, status: "success" },
          { id: "batch-5", label: "Terminology & Index", description: "术语表 + 索引 + 概览", fileCount: 2, status: "success" },
        ],
      },
    },
  },
  // === Phase 3: Verify ===
  {
    role: "agent",
    content: "导入完成，共生成 18 个 wiki pages。开始验证完整性...",
    steps: [
      { icon: "✨", text: "Batch 1: Data Tables — 5 pages generated" },
      { icon: "✨", text: "Batch 2: Scenarios & Flows — 4 pages generated" },
      { icon: "✨", text: "Batch 3: Rules & Routing — 4 pages generated" },
      { icon: "✨", text: "Batch 4: Templates — 3 pages generated" },
      { icon: "✨", text: "Batch 5: Terminology & Index — 2 pages generated" },
    ],
    phaseTransition: "verify",
    phaseData: {
      type: "verify",
      state: {
        status: "generating",
        questionCount: 0,
        coverage: 0,
        autoFixed: 0,
        needsInput: 0,
        cases: [],
        fixes: [],
      },
    },
  },
  {
    role: "agent",
    content: "",
    phaseData: {
      type: "verify",
      state: {
        status: "generating",
        questionCount: 4,
        coverage: 0,
        autoFixed: 0,
        needsInput: 0,
        cases: [],
        fixes: [],
      },
    },
  },
  {
    role: "agent",
    content: "",
    phaseData: {
      type: "verify",
      state: {
        status: "testing",
        questionCount: 8,
        coverage: 0,
        autoFixed: 0,
        needsInput: 0,
        cases: [
          { name: "Data table field coverage", status: "running" },
          { name: "Scenario trigger completeness", status: "running" },
          { name: "Email template placeholders", status: "running" },
          { name: "Region routing rules", status: "running" },
          { name: "Terminology consistency", status: "running" },
          { name: "Cross-reference links", status: "running" },
          { name: "Process step sequences", status: "running" },
          { name: "Exception handling logic", status: "running" },
        ],
        fixes: [],
      },
    },
  },
  {
    role: "agent",
    content: "",
    phaseData: {
      type: "verify",
      state: {
        status: "testing",
        questionCount: 8,
        coverage: 25,
        autoFixed: 0,
        needsInput: 0,
        cases: [
          { name: "Data table field coverage", status: "pass" },
          { name: "Scenario trigger completeness", status: "pass" },
          { name: "Email template placeholders", status: "running" },
          { name: "Region routing rules", status: "running" },
          { name: "Terminology consistency", status: "running" },
          { name: "Cross-reference links", status: "running" },
          { name: "Process step sequences", status: "running" },
          { name: "Exception handling logic", status: "running" },
        ],
        fixes: [],
      },
    },
  },
  {
    role: "agent",
    content: "",
    phaseData: {
      type: "verify",
      state: {
        status: "testing",
        questionCount: 8,
        coverage: 50,
        autoFixed: 0,
        needsInput: 0,
        cases: [
          { name: "Data table field coverage", status: "pass" },
          { name: "Scenario trigger completeness", status: "pass" },
          { name: "Email template placeholders", status: "pass" },
          { name: "Region routing rules", status: "pass" },
          { name: "Terminology consistency", status: "running" },
          { name: "Cross-reference links", status: "running" },
          { name: "Process step sequences", status: "running" },
          { name: "Exception handling logic", status: "running" },
        ],
        fixes: [
          "Added error codes to RefundAPI",
          "Fixed broken [[Checkout]] link",
          "Added missing tag to Order.md",
        ],
      },
    },
  },
  {
    role: "agent",
    content: "有一个不确定的点需要你确认：\n\n**订单取消后是否可以重新发起支付？** 我在 payment-service 代码中看到了 `reactivateOrder` 方法，但 checkout PRD 里没有提及这个场景。\n\n请确认：取消的订单能否被重新激活？",
    phaseData: {
      type: "verify",
      state: {
        coverage: 92,
        autoFixed: 5,
        needsInput: 1,
        cases: [
          { name: "Order lifecycle states", status: "pass" },
          { name: "Checkout flow completeness", status: "pass" },
          { name: "API endpoints documented", status: "pass" },
          { name: "Refund triggers correct", status: "pass" },
          { name: "Payment cancel→re-pay", status: "warning" },
          { name: "User roles coverage", status: "pass" },
        ],
        fixes: [
          "Added error codes to RefundAPI",
          "Fixed broken [[Checkout]] link",
          "Added missing tag to Order.md",
          "Added PaymentAPI timeout handling",
          "Linked User.md to auth flow",
        ],
      },
    },
  },
  {
    role: "user",
    content: "可以的，取消后 30 分钟内可以重新支付，超过则不行。",
  },
  {
    role: "agent",
    content: "已更新。验证全部通过，Ontology 构建完成！\n\n**Summary:**\n- 15 个页面生成\n- 覆盖率 96%\n- 5 个问题自动修复\n- 1 个人工确认\n\n你现在可以在右侧浏览 Ontology、查看知识图谱，或使用 Ask 进行问答。",
    phaseTransition: "ready",
    phaseData: {
      type: "verify",
      state: {
        coverage: 96,
        autoFixed: 5,
        needsInput: 0,
        cases: [
          { name: "Order lifecycle states", status: "pass" },
          { name: "Checkout flow completeness", status: "pass" },
          { name: "API endpoints documented", status: "pass" },
          { name: "Refund triggers correct", status: "pass" },
          { name: "Payment cancel→re-pay", status: "pass" },
          { name: "User roles coverage", status: "pass" },
        ],
        fixes: [
          "Added error codes to RefundAPI",
          "Fixed broken [[Checkout]] link",
          "Added missing tag to Order.md",
          "Added PaymentAPI timeout handling",
          "Linked User.md to auth flow",
        ],
      },
    },
  },
  {
    role: "agent",
    content: "验证完成，所有变更已准备就绪。请在右侧面板确认写入。",
    steps: [
      { icon: "📋", text: "Generated 8 verification questions" },
      { icon: "🤖", text: "Wiki QA agent tested all questions" },
      { icon: "✓", text: "6 pass / 2 fail" },
      { icon: "✏", text: "Auto-fixed: Terminology consistency" },
      { icon: "✏", text: "Auto-fixed: Cross-reference links" },
    ],
    phaseTransition: "review",
    phaseData: {
      type: "review",
      state: {
        description: "Initial wiki generation",
        files: [
          { path: "wiki/data_tables/MSD_WO.md", status: "new", content: "---\ntitle: MSD_WO\ntype: data_tables\n---\n\n## Summary\nMSD Work Order 主表，记录所有备件订单..." },
          { path: "wiki/data_tables/SSOC_Consumption.md", status: "new", content: "---\ntitle: SSOC_Consumption\ntype: data_tables\n---\n\n## Summary\nSSOC 消耗记录表..." },
          { path: "wiki/data_tables/ETA_Report.md", status: "new", content: "---\ntitle: ETA_Report\ntype: data_tables\n---\n\n## Summary\n预计到达时间报告..." },
          { path: "wiki/scenarios/Wrong_Order_Flow.md", status: "new", content: "---\ntitle: Wrong Order Flow\ntype: scenarios\n---\n\n## Trigger\n当订单信息与实际不符时触发..." },
          { path: "wiki/scenarios/WO_Stuck_Flow.md", status: "new", content: "---\ntitle: WO Stuck Flow\ntype: scenarios\n---\n\n## Trigger\n当 WO 状态超过 48h 未更新..." },
          { path: "wiki/scenarios/WO_Abnormal_Flow.md", status: "new", content: "---\ntitle: WO Abnormal Flow\ntype: scenarios\n---\n\n## Trigger\n当 WO 出现异常状态码..." },
          { path: "wiki/rules/Region_Routing.md", status: "new", content: "---\ntitle: Region Routing\ntype: rules\n---\n\n## Summary\n按区域分发邮件通知规则..." },
          { path: "wiki/rules/SLA_Escalation.md", status: "new", content: "---\ntitle: SLA Escalation\ntype: rules\n---\n\n## Summary\nSLA 升级触发条件与路径..." },
          { path: "wiki/templates/Wrong_Order_Email.md", status: "new", content: "---\ntitle: Wrong Order Email\ntype: templates\n---\n\nSubject: [Wrong Order] {{WO_ID}}..." },
          { path: "wiki/terminology/Glossary.md", status: "new", content: "---\ntitle: Glossary\ntype: terminology\n---\n\n| Term | Meaning |\n|------|---------|...\n\nSSOC → Standard Service Order Code" },
          { path: "wiki/index.md", status: "new", content: "---\ntitle: Wiki Index\n---\n\n## Data Tables\n- [MSD_WO](data_tables/MSD_WO.md)\n- [SSOC](data_tables/SSOC_Consumption.md)\n..." },
          { path: "wiki/overview.md", status: "new", content: "---\ntitle: Overview\n---\n\n## Summary\n本 Wiki 覆盖亚太区 IDG 备件订单管理运营知识..." },
        ],
      },
    },
  },
  // User requests modification (trigger: any message)
  {
    role: "user",
    content: "Region Routing 那部分需要补充一下按国家分发的逻辑，另外 Glossary 里缺少 PUDO 的解释。",
  },
  {
    role: "agent",
    content: "已更新。修改了 Region_Routing.md 和 Glossary.md，请确认变更。",
    phaseData: {
      type: "review",
      state: {
        description: "Updated based on user feedback",
        files: [
          { path: "wiki/data_tables/MSD_WO.md", status: "new", content: "---\ntitle: MSD_WO\ntype: data_tables\n---\n\n## Summary\nMSD Work Order 主表，记录所有备件订单..." },
          { path: "wiki/data_tables/SSOC_Consumption.md", status: "new", content: "---\ntitle: SSOC_Consumption\ntype: data_tables\n---\n\n## Summary\nSSOC 消耗记录表..." },
          { path: "wiki/data_tables/ETA_Report.md", status: "new", content: "---\ntitle: ETA_Report\ntype: data_tables\n---\n\n## Summary\n预计到达时间报告..." },
          { path: "wiki/scenarios/Wrong_Order_Flow.md", status: "new", content: "---\ntitle: Wrong Order Flow\ntype: scenarios\n---\n\n## Trigger\n当订单信息与实际不符时触发..." },
          { path: "wiki/scenarios/WO_Stuck_Flow.md", status: "new", content: "---\ntitle: WO Stuck Flow\ntype: scenarios\n---\n\n## Trigger\n当 WO 状态超过 48h 未更新..." },
          { path: "wiki/scenarios/WO_Abnormal_Flow.md", status: "new", content: "---\ntitle: WO Abnormal Flow\ntype: scenarios\n---\n\n## Trigger\n当 WO 出现异常状态码..." },
          { path: "wiki/rules/Region_Routing.md", status: "modified", oldContent: "---\ntitle: Region Routing\ntype: rules\nlast_updated: 2026-06-20\n---\n\n## Summary\n按区域分发邮件通知规则，覆盖亚太区所有 IDG 备件订单的邮件路由逻辑。\n\n## Trigger Conditions\n- Work Order 创建后 24h 内未处理\n- Work Order 状态异常\n- ETA 超期未更新\n\n## Routing Rules\n| Region | Owner |\n|--------|-------|\n| APAC | Regional Team |\n\n## Notification Template\n使用标准邮件模板，包含 WO_ID、Region、ETA 等字段。\n\n## Closure Conditions\n- Owner 回复确认\n- WO 状态更新为 Closed\n- 超过 7 天自动关闭", content: "---\ntitle: Region Routing\ntype: rules\nlast_updated: 2026-06-23\n---\n\n## Summary\n按区域分发邮件通知规则，覆盖亚太区所有 IDG 备件订单的邮件路由逻辑。\n\n## Trigger Conditions\n- Work Order 创建后 24h 内未处理\n- Work Order 状态异常\n- ETA 超期未更新\n\n## Country-level Routing\n| Country | Region | Solution Owner |\n|---------|--------|---------------|\n| CN | 中国区 | cn-solution@lenovo.com |\n| JP | 日本区 | jp-solution@lenovo.com |\n| AU/NZ | 澳新区 | aunz-solution@lenovo.com |\n| SEA | 东南亚区 | sea-solution@lenovo.com |\n| IN | 印度区 | in-solution@lenovo.com |\n| KR | 韩国区 | kr-solution@lenovo.com |\n\n## Routing Rules\n1. 首先按国家匹配 Solution Owner\n2. 匹配失败时回退到 Regional Team\n3. 周末/节假日自动升级到 Backup Owner\n\n## Notification Template\n使用标准邮件模板，包含 WO_ID、Region、ETA 等字段。\n\n## Escalation Path\n- Level 1: Solution Owner（24h）\n- Level 2: Regional Manager（48h）\n- Level 3: APAC Director（72h）\n\n## Closure Conditions\n- Owner 回复确认\n- WO 状态更新为 Closed\n- 超过 7 天自动关闭" },
          { path: "wiki/rules/SLA_Escalation.md", status: "new", content: "---\ntitle: SLA Escalation\ntype: rules\n---\n\n## Summary\nSLA 升级触发条件与路径..." },
          { path: "wiki/templates/Wrong_Order_Email.md", status: "new", content: "---\ntitle: Wrong Order Email\ntype: templates\n---\n\nSubject: [Wrong Order] {{WO_ID}}..." },
          { path: "wiki/terminology/Glossary.md", status: "modified", oldContent: "---\ntitle: Glossary\ntype: terminology\nlast_updated: 2026-06-20\n---\n\n## Abbreviations\n\n| Term | Full Name | Description |\n|------|-----------|-------------|\n| SSOC | Standard Service Order Code | 标准服务订单代码 |\n| MSD | Master Service Data | 主服务数据 |\n| PGI | Post Goods Issue | 发货后处理 |\n| ACCP | Acceptance | 签收确认 |\n| WHHD | Warehouse Handling | 仓库处理 |\n| DN | Delivery Note | 交货单 |\n| GI | Goods Issue | 出库 |\n| HAWB | House Air Waybill | 分运单 |", content: "---\ntitle: Glossary\ntype: terminology\nlast_updated: 2026-06-23\n---\n\n## Abbreviations\n\n| Term | Full Name | Description |\n|------|-----------|-------------|\n| SSOC | Standard Service Order Code | 标准服务订单代码 |\n| MSD | Master Service Data | 主服务数据 |\n| PGI | Post Goods Issue | 发货后处理 |\n| ACCP | Acceptance | 签收确认 |\n| WHHD | Warehouse Handling | 仓库处理 |\n| DN | Delivery Note | 交货单 |\n| GI | Goods Issue | 出库 |\n| HAWB | House Air Waybill | 分运单 |\n| PUDO | Pick Up Drop Off | 自助取件/投件点 |\n| ETA | Estimated Time of Arrival | 预计到达时间 |\n| SLA | Service Level Agreement | 服务等级协议 |\n\n## Status Codes\n\n| Code | Meaning |\n|------|---------|\n| WO_OPEN | Work Order 已创建 |\n| WO_ASSIGNED | 已分配 Solution Owner |\n| WO_IN_PROGRESS | 处理中 |\n| WO_CLOSED | 已关闭 |" },
          { path: "wiki/index.md", status: "new", content: "---\ntitle: Wiki Index\n---\n\n## Data Tables\n- [MSD_WO](data_tables/MSD_WO.md)\n- [SSOC](data_tables/SSOC_Consumption.md)\n..." },
          { path: "wiki/overview.md", status: "new", content: "---\ntitle: Overview\n---\n\n## Summary\n本 Wiki 覆盖亚太区 IDG 备件订单管理运营知识..." },
        ],
      },
    },
  },
  // User confirms in review (trigger: pending message from Confirm button)
  {
    role: "user",
    content: "确认，变更没问题。",
  },
  {
    role: "agent",
    content: "已写入完成！知识构建完毕，你现在可以自由提问或继续补充材料。",
  },
];
