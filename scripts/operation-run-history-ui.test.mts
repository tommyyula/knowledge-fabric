import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

test("Operation Run history client preserves filters and the next-page cursor", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dispatchEvent: () => true },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (originalWindow) Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    else delete (globalThis as { window?: unknown }).window;
  });

  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      data: {
        items: [{ id: "op_page_2", status: "running", logs: [], artifacts: [] }],
        nextCursor: "opaque-page-3",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { createServer } = await import("vite");
  const vite = await createServer({ appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  context.after(() => vite.close());
  const service = (await vite.ssrLoadModule(
    "/src/services/api/operations.ts",
  )) as typeof import("../src/services/api/operations.ts");

  const page = await service.listOperationRuns({
    ontologyId: "knowledge-base-a",
    sessionId: "conversation-a",
    search: "shipment 900",
    limit: 25,
    cursor: "opaque-page-2",
  });

  const query = new URL(requestedUrl, "http://localhost").searchParams;
  assert.deepEqual(Object.fromEntries(query), {
    ontologyId: "knowledge-base-a",
    sessionId: "conversation-a",
    search: "shipment 900",
    limit: "25",
    cursor: "opaque-page-2",
  });
  assert.deepEqual(
    { ids: page.items.map((run) => run.id), nextCursor: page.nextCursor },
    { ids: ["op_page_2"], nextCursor: "opaque-page-3" },
  );

  const history = (await vite.ssrLoadModule(
    "/src/lib/operation-run-history.ts",
  )) as typeof import("../src/lib/operation-run-history.ts");
  const run = (id: string, startedAt: string) => ({
    id,
    ontologyId: "knowledge-base-a",
    sessionId: "conversation-a",
    userRequest: id,
    status: "running" as const,
    logs: [],
    artifacts: [],
    startedAt,
  });
  const merged = history.mergeOperationRunPages([
    { items: [run("op_b", "2026-08-17T08:00:00.000Z"), run("op_a", "2026-08-17T08:00:00.000Z")], nextCursor: "page-2" },
    { items: [run("op_older", "2026-08-17T07:00:00.000Z"), run("op_a", "2026-08-17T08:00:00.000Z")] },
  ]);
  assert.deepEqual(merged.map((item) => item.id), ["op_b", "op_a", "op_older"]);

  const [{ default: OperationRunsPage }, { default: OperationRunList }] = await Promise.all([
    vite.ssrLoadModule("/src/components/OperationRunsPage.tsx") as Promise<typeof import("../src/components/OperationRunsPage.tsx")>,
    vite.ssrLoadModule("/src/components/OperationRunList.tsx") as Promise<typeof import("../src/components/OperationRunList.tsx")>,
  ]);
  const translations: Record<string, string> = {
    "operations.title": "Run History",
    "operations.search": "Search run history",
    "operations.allKnowledgeBases": "All knowledge bases",
    "operations.loadMore": "Load more",
    "operations.loading": "Loading run history",
    "operations.unavailableTitle": "Unable to load",
    "operations.unavailableBody": "Try again later",
    "operations.emptyTitle": "No runs yet",
    "operations.emptyBody": "Started runs appear here",
    "operations.task": "Task",
    "operations.knowledgeBase": "Knowledge base",
    "operations.startedAt": "Started",
    "operations.artifacts": "Artifacts",
    "operations.status.running": "Running",
  };
  const t = (key: string) => translations[key] ?? key;
  const queryClient = new QueryClient();
  queryClient.setQueryData(["operation-runs", "all", "all", ""], {
    pages: [{ items: [{ ...run("op_display", "2026-08-17T09:00:00.000Z"), title: "Displayed run" }], nextCursor: "page-2" }],
    pageParams: [""],
  });
  const historyHtml = renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(OperationRunsPage, { projects: [], onSelectRun: () => undefined, t }),
  ));
  assert.match(historyHtml, /Displayed run/);
  assert.match(historyHtml, /Load more/);
  assert.match(historyHtml, /All knowledge bases/);

  const listProps = { runs: [], onSelectRun: () => undefined, t };
  assert.match(renderToStaticMarkup(createElement(OperationRunList, { ...listProps, loading: true })), /Loading run history/);
  assert.match(renderToStaticMarkup(createElement(OperationRunList, { ...listProps, error: true })), /Unable to load/);
  assert.match(renderToStaticMarkup(createElement(OperationRunList, listProps)), /No runs yet/);
});
