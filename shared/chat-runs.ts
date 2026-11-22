import {
  readableError,
  type AssistantBridge,
  type ChatRequest,
  type ContextMode,
  type Turn,
} from './assistant.js';

export type RunKind = 'question' | 'summary' | 'review';
export type ActiveRun = {
  run: string;
  kind: RunKind;
  question: string;
  contextMode: ContextMode;
  // The latest text streamed by the agent.
  partial: string;
  startedAt: number;
};
// Everything the chat keeps for one PR between visits to it.
export type PrChat = {
  active: ActiveRun | null;
  // Answers received in this session, oldest first. Saved history holds them too.
  completed: Turn[];
  error: string;
  draft: string;
};
type Bridge = Pick<AssistantBridge, 'ask' | 'cancelAsk' | 'onActivity'>;
type StartOptions = {
  // Clear the composer draft when the answer to it arrives.
  clearDraft?: boolean;
  // Work to finish before asking, such as saving edited instructions.
  before?: () => Promise<unknown>;
};

const idle: PrChat = { active: null, completed: [], error: '', draft: '' };

// Owns the chat state of every PR, keyed by PR URL, outside any component. A run keeps
// going and keeps reporting here while another PR is on screen. Views subscribe to the
// PRs they show, so new kinds of run or new views need no change to the components
// that already use it.
export function createChatRuns(bridge: Bridge, now: () => number = Date.now) {
  let chats: ReadonlyMap<string, PrChat> = new Map();
  // Which PRs have a run, and of what kind. Replaced only when a run starts or ends, so a
  // view of activity across PRs is not redrawn for every streamed word or keystroke.
  let working: ReadonlyMap<string, RunKind> = new Map();
  const listeners = new Set<() => void>();
  const cancelled = new Set<string>();
  let listening = false;
  const get = (url: string) => chats.get(url) ?? idle;
  function update(url: string, change: (chat: PrChat) => PrChat) {
    const current = get(url),
      next = change(current);
    if (next === current) return;
    chats = new Map(chats).set(url, next);
    if (next.active?.run !== current.active?.run) {
      const runs = new Map(working);
      if (next.active) runs.set(url, next.active.kind);
      else runs.delete(url);
      working = runs;
    }
    for (const listener of listeners) listener();
  }
  // Only the run that is still current for its PR may change that PR's state.
  function settle(url: string, run: string, change: (chat: PrChat) => PrChat) {
    cancelled.delete(run);
    update(url, (chat) => (chat.active?.run === run ? change({ ...chat, active: null }) : chat));
  }
  return {
    get,
    working: () => working,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDraft(url: string, draft: string) {
      update(url, (chat) => (chat.draft === draft ? chat : { ...chat, draft }));
    },
    // Returns false when this PR already has a run.
    start(request: ChatRequest, kind: RunKind, options: StartOptions = {}) {
      const { url, run } = request;
      if (get(url).active) return false;
      if (!listening) {
        listening = true;
        bridge.onActivity((event) => {
          for (const [pr, chat] of chats)
            if (chat.active?.run === event.run)
              update(pr, (c) =>
                c.active ? { ...c, active: { ...c.active, partial: event.text } } : c,
              );
        });
      }
      update(url, (chat) => ({
        ...chat,
        error: '',
        active: {
          run,
          kind,
          question: request.question,
          contextMode: request.contextMode ?? 'focused',
          partial: '',
          startedAt: now(),
        },
      }));
      void (async () => {
        try {
          await options.before?.();
          if (cancelled.has(run)) throw new Error('Review cancelled.');
          const turn = await bridge.ask({ ...request, kind });
          settle(url, run, (chat) => ({
            ...chat,
            error: '',
            completed: [...chat.completed.filter((t) => t.run !== turn.run), turn],
            draft: options.clearDraft && chat.draft.trim() === request.question ? '' : chat.draft,
          }));
        } catch (error) {
          settle(url, run, (chat) => ({ ...chat, error: readableError(error) }));
        }
      })();
      return true;
    },
    cancel(url: string) {
      const run = get(url).active?.run;
      if (!run) return;
      cancelled.add(run);
      bridge.cancelAsk(run).catch((error: unknown) => {
        update(url, (chat) => ({ ...chat, error: readableError(error) }));
      });
    },
  };
}
export type ChatRuns = ReturnType<typeof createChatRuns>;
