// Tracks the agent runs in flight. Each PR has at most one, and runs for different PRs
// proceed independently, so opening another PR never interrupts an answer.
export function chatRuns(limit = 3) {
  const active = new Map<string, { id: string; controller: AbortController }>();
  return {
    isRunning: (url: string) => active.has(url),
    begin(url: string, id: string): AbortSignal {
      if (active.has(url))
        throw new Error(
          'An answer is already running for this PR. Cancel it or wait for it to finish.',
        );
      if (active.size >= limit)
        throw new Error(
          limit + ' answers are already running in other PRs. Wait for one to finish.',
        );
      const controller = new AbortController();
      active.set(url, { id, controller });
      return controller.signal;
    },
    // A run only clears its own entry, so a late finish cannot release a newer run.
    end(url: string, id: string) {
      if (active.get(url)?.id === id) active.delete(url);
    },
    cancel(id: string) {
      for (const run of active.values()) if (run.id === id) run.controller.abort();
    },
    cancelAll() {
      for (const run of active.values()) run.controller.abort();
    },
  };
}
