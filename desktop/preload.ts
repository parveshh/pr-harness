import { failureLocation, failureReport } from '../shared/failure.js';
import { freshness, candidate, pairSummary, pairAnalysis } from '../shared/cross-pr.js';
import { reviewLesson } from '../shared/lessons.js';
import { discussionMessage, discussions, resolveResult } from '../shared/discussions.js';
import { typography, signIn, inbox } from '../shared/workspace.js';
import { accent, appearance } from '../shared/appearance.js';
import { contextBridge, ipcRenderer } from 'electron';
import { pullRequestUrl, reviewList, type ReviewerBridge } from '../shared/reviews.js';
import { reviewBundle } from '../shared/publish.js';
import { pinnedQuestion, questionEvidence } from '../shared/questions.js';
import { changeEvidence } from '../shared/rereview.js';
import { readerView } from '../shared/reader.js';
import { z } from 'zod';
import { pipelines, pipelineJob } from '../shared/pipelines.js';
import { repository, config, agentCatalog, turn, activity } from '../shared/assistant.js';

const reviewer: ReviewerBridge = {
  comparisonCandidates: async (repo, run) =>
    candidate.array().parse(await ipcRenderer.invoke('pair:candidates', repo, run)),
  cancelCandidateScan: async (run) => {
    await ipcRenderer.invoke('pair:cancel-candidates', run);
  },
  preparePair: async (request) =>
    pairSummary.parse(await ipcRenderer.invoke('pair:prepare', request)),
  analyzePair: async (run) => pairAnalysis.parse(await ipcRenderer.invoke('pair:analyze', run)),
  checkPair: async (run) => freshness.parse(await ipcRenderer.invoke('pair:check', run)),
  closePair: async (run) => {
    await ipcRenderer.invoke('pair:close', run);
  },
  reviewLessons: async (url) =>
    reviewLesson.array().parse(await ipcRenderer.invoke('lessons:list', url)),
  saveReviewLesson: async (input) =>
    reviewLesson.array().parse(await ipcRenderer.invoke('lessons:save', input)),
  forgetReviewLesson: async (url, key) =>
    reviewLesson.array().parse(await ipcRenderer.invoke('lessons:forget', url, key)),
  discussions: async (url) => discussions.parse(await ipcRenderer.invoke('discussions:list', url)),
  replyToDiscussion: async (req) =>
    discussionMessage.parse(await ipcRenderer.invoke('discussions:reply', req)),
  pipelineAttempt: async (key, session) =>
    pipelineJob.array().parse(await ipcRenderer.invoke('pipelines:attempt', key, session)),
  investigateFailure: async (key) =>
    failureReport.parse(await ipcRenderer.invoke('pipelines:investigate', key)),
  failureLocation: async (session, index, request) =>
    failureLocation.parse(await ipcRenderer.invoke('pipelines:location', session, index, request)),
  closeFailureLocation: async (request) => {
    await ipcRenderer.invoke('pipelines:close-location', request);
  },
  closeFailure: async (session) => {
    await ipcRenderer.invoke('pipelines:close-failure', session);
  },
  pipelines: async (url) => pipelines.parse(await ipcRenderer.invoke('pipelines:list', url)),
  resolveDiscussion: async (req) =>
    resolveResult.parse(await ipcRenderer.invoke('discussions:resolve', req)),
  typography: async () => typography.parse(await ipcRenderer.invoke('settings:type')),
  saveTypography: async (value) =>
    typography.parse(await ipcRenderer.invoke('settings:save-type', value)),
  syncReplies: async () => inbox.parse(await ipcRenderer.invoke('replies:sync')),
  readReplies: async (account) => inbox.parse(await ipcRenderer.invoke('replies:read', account)),
  openReply: async (account, id) =>
    inbox.parse(await ipcRenderer.invoke('replies:open', account, id)),
  startLogin: async () => signIn.parse(await ipcRenderer.invoke('account:start')),
  loginProgress: async () => signIn.parse(await ipcRenderer.invoke('account:progress')),
  cancelLogin: async () => {
    await ipcRenderer.invoke('account:cancel');
  },
  openChatLink: async (url) => {
    await ipcRenderer.invoke('chat:open-link', url);
  },
  openDevicePage: async () => {
    await ipcRenderer.invoke('account:device');
  },
  integratedTitleBar: process.platform === 'darwin',
  getAppearance: async () => appearance.parse(await ipcRenderer.invoke('appearance:get')),
  saveAppearance: async (value) => {
    await ipcRenderer.invoke('appearance:save', value);
  },
  getAccent: async () => accent.parse(await ipcRenderer.invoke('accent:get')),
  saveAccent: async (value) => {
    await ipcRenderer.invoke('accent:save', value);
  },
  reviewDrafts: async (url) => reviewBundle.parse(await ipcRenderer.invoke('drafts:list', url)),
  editDrafts: async (url, version, edit) =>
    reviewBundle.parse(await ipcRenderer.invoke('drafts:edit', { url, version }, edit)),
  reviewIdentity: async () => z.string().parse(await ipcRenderer.invoke('publish:identity')),
  publishReview: async (key) => reviewBundle.parse(await ipcRenderer.invoke('publish:send', key)),
  checkSubmission: async (url) =>
    reviewBundle.parse(await ipcRenderer.invoke('publish:check', url)),
  reopenDrafts: async (url, version) =>
    reviewBundle.parse(await ipcRenderer.invoke('publish:reopen', { url, version })),
  openReceipt: async (url) => {
    await ipcRenderer.invoke('publish:receipt', url);
  },
  repositories: async () => repository.array().parse(await ipcRenderer.invoke('repos:list')),
  addRepository: async (name) =>
    repository.array().parse(await ipcRenderer.invoke('repos:add', name)),
  syncRepository: async (name, discover) =>
    repository.array().parse(await ipcRenderer.invoke('repos:sync', name, discover)),
  watchAuthors: async (name, authors) =>
    repository.array().parse(await ipcRenderer.invoke('repos:watch', name, authors)),
  onOpenPr(callback) {
    const listener = (_: unknown, value: unknown) => callback(pullRequestUrl.parse(value));
    ipcRenderer.on('monitor:open', listener);
    return () => {
      ipcRenderer.removeListener('monitor:open', listener);
    };
  },
  removeRepository: async (name) =>
    repository.array().parse(await ipcRenderer.invoke('repos:remove', name)),
  assessFinding: async (value) =>
    turn.parse(await ipcRenderer.invoke('chat:assess-finding', value)),
  draftFindings: async (value) =>
    z
      .object({ turn, bundle: reviewBundle })
      .parse(await ipcRenderer.invoke('chat:draft-findings', value)),
  agentConfig: async (url) => config.parse(await ipcRenderer.invoke('agent:config', url)),
  agentSelection: async () => agentCatalog.parse(await ipcRenderer.invoke('agent:selection')),
  saveSelection: async (value) =>
    agentCatalog.parse(await ipcRenderer.invoke('agent:select', value)),
  savePrompt: async (url, scope, prompt, purpose = 'review') =>
    config.parse(await ipcRenderer.invoke('agent:save-prompt', url, scope, prompt, purpose)),
  clearPrompt: async (url, target, purpose = 'review') =>
    config.parse(await ipcRenderer.invoke('agent:clear-prompt', url, target, purpose)),
  chooseExecutable: async (agent) =>
    z.boolean().parse(await ipcRenderer.invoke('agent:choose', agent)),
  history: async (url) => turn.array().parse(await ipcRenderer.invoke('chat:history', url)),
  ask: async (req) => turn.parse(await ipcRenderer.invoke('chat:ask', req)),
  cancelAsk: async (run) => {
    await ipcRenderer.invoke('chat:cancel', run);
  },
  onActivity(callback) {
    const listener = (_: unknown, value: unknown) => callback(activity.parse(value));
    ipcRenderer.on('chat:activity', listener);
    return () => {
      ipcRenderer.removeListener('chat:activity', listener);
    };
  },
  activeReview: async () =>
    pullRequestUrl.nullable().parse(await ipcRenderer.invoke('reader:active')),
  selectReview: async (url) => {
    await ipcRenderer.invoke('reader:select', url);
  },
  cachedReview: async (url) =>
    readerView.nullable().parse(await ipcRenderer.invoke('reader:cached', url)),
  refreshReview: async (url) =>
    readerView.nullable().parse(await ipcRenderer.invoke('reader:refresh', url)),
  comparisonPosition: async (url, revision, since, path) => {
    await ipcRenderer.invoke('reader:comparison-position', { url, revision, since, path });
  },
  checkUpdate: async (url) =>
    z
      .string()
      .nullable()
      .parse(await ipcRenderer.invoke('reader:probe', url)),
  openUpdate: async (url, revision) =>
    readerView.parse(await ipcRenderer.invoke('reader:open-update', { url, revision })),
  finishRevision: async (url, revision) =>
    readerView.parse(await ipcRenderer.invoke('reader:finish', { url, revision })),
  markComparisonFile: async (key, reviewed) =>
    readerView.parse(await ipcRenderer.invoke('reader:comparison-mark', key, reviewed)),
  changeEvidence: async (key) =>
    changeEvidence.parse(await ipcRenderer.invoke('reader:evidence', key)),
  pinQuestion: async (request) =>
    pinnedQuestion.array().parse(await ipcRenderer.invoke('questions:pin', request)),
  addressQuestion: async (key, addressed) =>
    pinnedQuestion.array().parse(await ipcRenderer.invoke('questions:address', key, addressed)),
  questionEvidence: async (key) =>
    questionEvidence.parse(await ipcRenderer.invoke('questions:evidence', key)),
  citedSource: async (key) =>
    z.string().parse(await ipcRenderer.invoke('reader:cited-source', key)),
  fullFile: async (key) => z.string().parse(await ipcRenderer.invoke('reader:full-file', key)),
  filePatch: async (key) => z.string().parse(await ipcRenderer.invoke('reader:patch', key)),
  remember: async (value) => {
    await ipcRenderer.invoke('reader:remember', value);
  },
  listReviews: async () => reviewList.parse(await ipcRenderer.invoke('reviews:list')),
  saveReview: async (url) => reviewList.parse(await ipcRenderer.invoke('reviews:save', url)),
};
contextBridge.exposeInMainWorld('reviewer', reviewer);
