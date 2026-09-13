export interface ReconnectFetchController {
  fetch: typeof globalThis.fetch;
  abort: () => void;
}

export function createReconnectFetchController(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): ReconnectFetchController {
  let activeController: AbortController | null = null;

  const controlledFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return fetchImpl(input, init);

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    return fetchImpl(input, { ...init, signal });
  }) as typeof globalThis.fetch;

  return {
    fetch: controlledFetch,
    abort: () => {
      const controller = activeController;
      activeController = null;
      controller?.abort();
    },
  };
}
