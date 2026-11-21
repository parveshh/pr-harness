import type { WorkspaceBridge } from './workspace.js';
import type { PinnedQuestion, QuestionKey, PinQuestion, QuestionEvidence } from './questions.js';
import type { ChangeEvidence } from './rereview.js';
import type { Appearance } from './appearance.js';
import { z } from 'zod';
import type { PublishBridge } from './publish.js';
import type { AssistantBridge } from './assistant.js';
import type { Checkpoint, FileKey, ReaderView } from './reader.js';

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
export const savedReview = z.object({ url: pullRequestUrl, savedAt: z.iso.datetime() });
export const reviewList = z.array(savedReview);
export type SavedReview = z.infer<typeof savedReview>;
export interface ReviewerBridge extends AssistantBridge, PublishBridge, WorkspaceBridge {
  readonly integratedTitleBar: boolean;
  getAppearance(): Promise<Appearance>;
  saveAppearance(value: Appearance): Promise<void>;
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
  checkUpdate(url: string): Promise<string | null>;
  openUpdate(url: string, revision: string): Promise<ReaderView>;
  finishRevision(url: string, revision: string): Promise<ReaderView>;
  markComparisonFile(key: FileKey, reviewed: boolean): Promise<ReaderView>;
  changeEvidence(key: FileKey): Promise<ChangeEvidence>;
  pinQuestion(request: PinQuestion): Promise<PinnedQuestion[]>;
  addressQuestion(key: QuestionKey, addressed: boolean): Promise<PinnedQuestion[]>;
  questionEvidence(key: QuestionKey): Promise<QuestionEvidence>;
  fullFile(key: FileKey): Promise<string>;
  filePatch(key: FileKey): Promise<string>;
  remember(checkpoint: Checkpoint): Promise<void>;
  listReviews(): Promise<SavedReview[]>;
  saveReview(url: string): Promise<SavedReview[]>;
}
