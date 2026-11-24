import { useSyncExternalStore } from 'react';
import { createChatRuns } from '../../shared/chat-runs.js';

// One store for the window. It outlives the reader, which is rebuilt for each PR.
export const chatRuns = createChatRuns({
  newConversation: (url) => window.reviewer.newConversation(url),
  ask: (request) => window.reviewer.ask(request),
  cancelAsk: (run) => window.reviewer.cancelAsk(run),
  onActivity: (callback) => window.reviewer.onActivity(callback),
});

// The chat of one PR: its run in progress, answers, error and composer draft.
export function usePrChat(url: string) {
  return useSyncExternalStore(chatRuns.subscribe, () => chatRuns.get(url));
}
// The PRs that have a run in progress, for views that show activity across PRs.
export function useWorkingPrs() {
  return useSyncExternalStore(chatRuns.subscribe, chatRuns.working);
}
