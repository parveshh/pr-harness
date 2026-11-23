import type { CrossPrBridge } from './cross-pr.js';
import type { WorkspaceBridge } from './workspace.js';
import type { PipelineBridge } from './pipelines.js';
import type { PinnedQuestion, QuestionKey, PinQuestion, QuestionEvidence } from './questions.js';
import type { ChangeEvidence } from './rereview.js';
import type { Accent, Appearance } from './appearance.js';
import { z } from 'zod';
import type { PublishBridge } from './publish.js';
import type { AssistantBridge, CitedSourceKey } from './assistant.js';
import type { Checkpoint, FileKey, ReaderView, reviewUpdate } from './reader.js';
import type { LocalBridge } from './local.js';

// Store a single canonical URL even when a reviewer copies a link from the Files tab.
export const pullRequestUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(
    /^https:\/\/github\.com\/[a-z0-9-]+\/(?!\.{1,2}\/)[a-z0-9_.-]+\/pull\/[1-9]\d*(?:\/(?:files|commits|checks))?\/?(?:[?#][^\s]*)?$/i,
    'Enter a GitHub pull request URL.',
  )
  .transform((value) => {
    return value
      .replace(/[?#].*$/, '')
      .replace(/\/(?:files|commits|checks)\/?$|\/$/i, '')
      .toLowerCase();
  });
// A local branch review has an opaque key so that filesystem paths stay out of keys, logs and
// agent prompts. The repository location is stored separately in local_reviews.
export const localReviewKey = z
  .string()
  .trim()
  .regex(
    /^local:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Choose a saved local review.',
  )
  .transform((value) => value.toLowerCase());
// Operations that make sense for both kinds of review accept either key. GitHub-only
// operations keep `pullRequestUrl`, so a local key fails validation there.
export const reviewKey = z.union([pullRequestUrl, localReviewKey]);
export function isLocalReview(key: string) {
  return key.startsWith('local://');
}
export const localReviewInfo = z.object({
  repository: z.string(),
  branch: z.string().nullable(),
  baseBranch: z.string(),
  path: z.string(),
});
export type LocalReviewInfo = z.infer<typeof localReviewInfo>;
export const savedReview = z.object({
  url: reviewKey,
  savedAt: z.iso.datetime(),
  isDraft: z.boolean().optional(),
  local: localReviewInfo.optional(),
});
export const reviewList = z.array(savedReview);
export type SavedReview = z.infer<typeof savedReview>;
export interface ReviewerBridge
  extends
    AssistantBridge,
    PublishBridge,
    WorkspaceBridge,
    PipelineBridge,
    CrossPrBridge,
    LocalBridge {
  readonly integratedTitleBar: boolean;
  getAppearance(): Promise<Appearance>;
  saveAppearance(value: Appearance): Promise<void>;
  getAccent(): Promise<Accent>;
  saveAccent(value: Accent): Promise<void>;
  activeReview(): Promise<string | null>;
  selectReview(url: string | null): Promise<void>;
  cachedReview(url: string): Promise<ReaderView | null>;
  refreshReview(url: string): Promise<ReaderView | null>;
  comparisonPosition(
    url: string,
    revision: string,
    since: boolean,
    path: string | null,
  ): Promise<void>;
  checkUpdate(url: string): Promise<z.infer<typeof reviewUpdate>>;
  openUpdate(url: string, revision: string): Promise<ReaderView>;
  finishRevision(url: string, revision: string): Promise<ReaderView>;
  markComparisonFile(key: FileKey, reviewed: boolean): Promise<ReaderView>;
  changeEvidence(key: FileKey): Promise<ChangeEvidence>;
  pinQuestion(request: PinQuestion): Promise<PinnedQuestion[]>;
  addressQuestion(key: QuestionKey, addressed: boolean): Promise<PinnedQuestion[]>;
  questionEvidence(key: QuestionKey): Promise<QuestionEvidence>;
  citedSource(key: CitedSourceKey): Promise<string>;
  fullFile(key: FileKey): Promise<string>;
  filePatch(key: FileKey): Promise<string>;
  remember(checkpoint: Checkpoint): Promise<void>;
  listReviews(): Promise<SavedReview[]>;
  saveReview(url: string): Promise<SavedReview[]>;
}
