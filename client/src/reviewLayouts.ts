export const reviewLayouts = {
  'files-diff-chat': ['files', 'diff', 'chat'],
  'chat-diff-files': ['chat', 'diff', 'files'],
  'diff-files-chat': ['diff', 'files', 'chat'],
  'diff-chat-files': ['diff', 'chat', 'files'],
  'files-chat-diff': ['files', 'chat', 'diff'],
  'chat-files-diff': ['chat', 'files', 'diff'],
} as const;

export type ReviewLayout = keyof typeof reviewLayouts;
export type ReviewPane = (typeof reviewLayouts)[ReviewLayout][number];
export const defaultReviewLayout: ReviewLayout = 'files-diff-chat';
export const paneLabels = { files: 'Files', diff: 'Diff', chat: 'Chat' };
const layoutKey = 'workspace.review-pane-order';

function isReviewLayout(value: string | null): value is ReviewLayout {
  return value !== null && Object.hasOwn(reviewLayouts, value);
}

export function readReviewLayout(): ReviewLayout {
  try {
    const value = localStorage.getItem(layoutKey);
    return isReviewLayout(value) ? value : defaultReviewLayout;
  } catch {
    return defaultReviewLayout;
  }
}

export function saveReviewLayout(layout: ReviewLayout) {
  localStorage.setItem(layoutKey, layout);
}

export const layoutChoices = Object.keys(reviewLayouts).filter(isReviewLayout);
