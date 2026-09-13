/**
 * Chat Task Manager — decouples agent execution from SSE connection lifecycle.
 *
 * Translated from mkp-llm-wiki-agent/service/session_task_manager.py.
 * Agent runs in a background task; SSE connections subscribe/replay events.
 * Closing the browser only disconnects the subscriber, not the execution.
 */

type Subscriber = (frame: string | null) => void;

export interface ChatTask {
  key: string;
  events: string[];
  done: boolean;
  subscribers: Set<Subscriber>;
  abortController: AbortController;
  startedAt: number;
  _cleanupTimer?: ReturnType<typeof setTimeout>;
}

const activeTasks = new Map<string, ChatTask>();
const keyAliases = new Map<string, string>();

const RETENTION_MS = 60_000;

function resolveKey(key: string): string {
  return keyAliases.get(key) ?? key;
}

export function getTask(key: string): ChatTask | undefined {
  return activeTasks.get(resolveKey(key));
}

export function getStatus(key: string): { active: boolean; eventCount: number } {
  const task = getTask(key);
  if (!task) return { active: false, eventCount: 0 };
  return { active: !task.done, eventCount: task.events.length };
}

export function startTask(
  key: string,
  eventGenerator: AsyncIterable<string>,
  onComplete?: (task: ChatTask) => void,
): ChatTask {
  const existing = getTask(key);
  if (existing && !existing.done) return existing;

  const abortController = new AbortController();
  const task: ChatTask = {
    key,
    events: [],
    done: false,
    subscribers: new Set(),
    abortController,
    startedAt: Date.now(),
  };
  activeTasks.set(key, task);

  const run = async () => {
    try {
      for await (const frame of eventGenerator) {
        if (abortController.signal.aborted) break;
        broadcast(task, frame);
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        const errorFrame = `event: error\ndata: ${JSON.stringify({ type: "error", error: err instanceof Error ? err.message : String(err) })}\n\n`;
        broadcast(task, errorFrame);
      }
    } finally {
      if (onComplete) {
        try { onComplete(task); } catch { /* silent */ }
      }
      finish(task);
      // Keep task briefly for late subscribers (refresh/reconnect races)
      task._cleanupTimer = setTimeout(() => {
        activeTasks.delete(resolveKey(key));
        // Clean up any aliases pointing to this key
        for (const [alias, target] of keyAliases) {
          if (target === resolveKey(key)) keyAliases.delete(alias);
        }
      }, RETENTION_MS);
    }
  };

  // Fire and forget — runs independently of any HTTP connection
  run().catch(() => { /* already handled inside */ });

  return task;
}

function broadcast(task: ChatTask, frame: string): void {
  task.events.push(frame);
  for (const subscriber of task.subscribers) {
    try { subscriber(frame); } catch { /* subscriber errored, ignore */ }
  }
}

function finish(task: ChatTask): void {
  task.done = true;
  for (const subscriber of task.subscribers) {
    try { subscriber(null); } catch { /* ignore */ }
  }
}

export async function* subscribe(key: string, fromIndex = 0): AsyncGenerator<string> {
  const task = getTask(key);
  if (!task) return;

  // Set up subscriber BEFORE replay to avoid race (same as mkp)
  let resolve: ((value: string | null) => void) | null = null;
  const queue: (string | null)[] = [];

  const subscriber: Subscriber = (frame) => {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(frame);
    } else {
      queue.push(frame);
    }
  };

  task.subscribers.add(subscriber);

  try {
    // Replay buffered events
    for (const frame of task.events.slice(fromIndex)) {
      yield frame;
    }

    if (task.done) return;

    // Tail new events
    while (true) {
      let frame: string | null;
      if (queue.length > 0) {
        frame = queue.shift()!;
      } else {
        frame = await new Promise<string | null>((r) => { resolve = r; });
      }
      if (frame === null) break;
      yield frame;
    }
  } finally {
    task.subscribers.delete(subscriber);
  }
}

export function cancelTask(key: string): boolean {
  const task = getTask(key);
  if (!task || task.done) return false;
  task.abortController.abort();
  finish(task);
  if (task._cleanupTimer) clearTimeout(task._cleanupTimer);
  task._cleanupTimer = setTimeout(() => {
    activeTasks.delete(resolveKey(key));
  }, RETENTION_MS);
  return true;
}

export function aliasKey(alias: string, target: string): void {
  const resolved = resolveKey(target);
  if (alias === resolved) return;
  keyAliases.set(alias, resolved);
}

export function rekeyTask(oldKey: string, newKey: string): void {
  const resolved = resolveKey(oldKey);
  if (resolved === newKey) return;

  const task = activeTasks.get(resolved);
  if (!task) {
    aliasKey(resolved, newKey);
    return;
  }

  activeTasks.set(newKey, task);
  task.key = newKey;
  activeTasks.delete(resolved);
  aliasKey(resolved, newKey);
}
