import { finding, type AssessFinding } from './findings.js';
import { z } from 'zod';
import { isLocalReview, pullRequestUrl, pullSidebarFields, reviewKey } from './reviews.js';

export const defaultPrompt = `Answer the reviewer’s question directly. Match the scope to the request. For a line or file explanation, start with what the selected code does. For a new file, explain its responsibility and where it is used. For a whole PR review, lead with the findings that would most affect the decision to merge.

Understand the change. Identify the behaviour the author intends and check it against the pinned diff. Trace a representative input from the entry point through the changed code to the value returned, state saved, or action the user sees. Compare that path before and after the change. Follow relevant callers, types, and tests when the supplied evidence allows it. Pay attention to removed checks and to unchanged callers that rely on the old contract.

Check where the behaviour can break. Choose cases that follow from this change. For example, if a write can be retried after a timeout, trace what happens when the first write succeeded. For a schema or API change, consider existing records and callers. At a permissions boundary, check who may perform the action and on whose data. Consider resource use when work grows with input size. Raise a concern when you can describe a realistic trigger and an observable consequence.

Read the tests as a caller would. Identify the setup, the action, and the outcome the assertions actually verify. For a bug fix, ask whether that assertion would have caught the old behaviour. If an important path is uncovered, describe one specific case and the outcome it should assert. Distinguish reading a test from observing it pass.

Report each distinct finding once, highest impact first. Give it a short title naming the failure. Explain who or what triggers it, which changed line causes it, and the effect on the caller or user. Cite the relevant lines using the supplied evidence IDs. Suggest a focused correction or verification step when it helps. If evidence is incomplete, identify the missing caller, source, or test and explain which conclusion depends on it. If you find no actionable defect, say so plainly and mention any material gap in coverage. Keep routine changes brief.`;
export const defaultSummaryPrompt = `Help a reviewer understand this pull request before reading it. Start with its purpose and the observable behaviour before and after the change. Group related changes by behaviour, name the entry points and files that explain them, and give a short reading order for the most consequential changes. Describe what the tests cover and identify any material gaps in the available evidence. Cite the pinned evidence for factual claims and distinguish the author’s stated intent from what the diff shows. Keep routine changes brief.`;
export const promptPurpose = z.enum(['review', 'summary']);
export type PromptPurpose = z.infer<typeof promptPurpose>;
export const prReviewQuestion =
  'Review this whole pull request for actionable defects. Trace affected callers and tests, report the impact of each finding, and propose a concise inline comment suitable for the author. State any material gaps in coverage.';
export const repoName = z
  .string()
  .trim()
  .transform((value) => value.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, ''))
  .pipe(
    z
      .string()
      .regex(/^[a-z0-9-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/i, 'Enter owner/repository or its GitHub URL.')
      .max(180)
      .toLowerCase(),
  );
export const login = z
  .string()
  .trim()
  .regex(/^[\w-]+(?:\[bot\])?$/i)
  .max(100)
  .toLowerCase();
export const agentId = z.enum(['codex', 'claude', 'cursor', 'antigravity', 'copilot']);
// One harness and model serve the whole app. Review prompts stay scoped to the app,
// a repository, or a PR.
export const selection = z.object({
  agent: agentId,
  model: z
    .string()
    .trim()
    .max(180)
    .refine(
      (v) => !v.startsWith('-') && !Array.from(v).some((c) => c.charCodeAt(0) < 33 || /\s/.test(c)),
      'Use a model identifier without spaces.',
    ),
  provider: z.enum(['default', 'ollama', 'lmstudio']),
});
export const reviewPrompt = z.string().trim().min(1).max(16000);
export const prefs = selection.extend({ prompt: reviewPrompt });
export const agentInfo = z.object({
  id: agentId,
  path: z.string(),
  version: z.string(),
  models: z.array(z.string()),
});
export const scope = z.enum(['default', 'repository', 'review']);
export const config = z.object({
  agents: z.array(agentInfo),
  settings: prefs,
  scope,
  summary: z.object({ scope, prompt: reviewPrompt }),
});
export const agentCatalog = z.object({ agents: z.array(agentInfo), selection });
export const agentNames: Record<AgentId, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
  cursor: 'Cursor Agent',
  antigravity: 'Antigravity CLI',
  copilot: 'GitHub Copilot CLI',
};
export const summaryQuestion =
  'Summarise this whole pull request. State its purpose, then the main behaviour changes grouped by area, the riskiest changes to read first, and any gaps in the tests. List changed files you did not inspect.';
export const anchor = z.object({
  path: z.string(),
  hunk: z.number().int().nonnegative(),
  side: z.enum(['old', 'new']),
  line: z.number().int().positive(),
});
export const lineRange = anchor.extend({ startLine: z.number().int().positive().optional() });
export const citation = anchor.extend({ id: z.number().int().positive(), excerpt: z.string() });
export const contextMode = z.enum(['focused', 'full-pr']);
export type ContextMode = z.infer<typeof contextMode>;
export const sourceCitation = z.object({
  id: z.number().int().positive(),
  path: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  side: z.enum(['head', 'before']),
  line: z.number().int().positive(),
  url: z.string(),
});
export const citedSourceKey = z.object({
  url: reviewKey,
  run: z.uuid(),
  id: z.number().int().positive(),
});
export type CitedSourceKey = z.infer<typeof citedSourceKey>;
export type SourceCitation = z.infer<typeof sourceCitation>;
export const chatRequest = z.object({
  kind: z.enum(['question', 'summary', 'review']).optional(),
  contextMode: contextMode.optional(),
  run: z.uuid(),
  url: reviewKey,
  revision: z.string(),
  path: z.string(),
  hunk: z.number().int().nonnegative(),
  selection: lineRange.refine((range) => (range.startLine ?? range.line) <= range.line).nullable(),
  extra: z.string().nullable(),
  question: z.string().trim().min(1).max(8000),
});
export const turn = z.object({
  archived: z.literal(true).optional(),
  findings: finding.array().optional(),
  contextMode: contextMode.optional(),
  run: z.uuid(),
  revision: z.string(),
  path: z.string(),
  question: z.string(),
  answer: z.string(),
  changedEvidence: z.string().array().optional(),
  citations: z.array(citation),
  sourceCitations: z.array(sourceCitation).optional(),
  settings: prefs,
  promptVersion: z.string(),
  reportedModel: z.string().nullable(),
});
export const activity = z.object({ run: z.uuid(), text: z.string() });
export const watchPr = z.object({
  ...pullSidebarFields,
  number: z.number().int().positive(),
  title: z.string(),
  author: login,
  // Whether the signed-in reviewer's latest review on GitHub approves the PR.
  approved: z.boolean().default(false),
  isDraft: z.boolean().optional(),
  // Appeared since the last check and not opened yet.
  unseen: z.boolean().default(false),
});
export const repository = z.object({
  name: repoName,
  authors: z.array(login),
  watching: z.array(login),
  pulls: z.array(watchPr),
  checked: z.string().nullable(),
  error: z.string().nullable(),
});
export type Repository = z.infer<typeof repository>;
export type Preferences = z.infer<typeof prefs>;
export type Selection = z.infer<typeof selection>;
export type AgentCatalog = z.infer<typeof agentCatalog>;
export type AgentId = z.infer<typeof agentId>;
export type AgentInfo = z.infer<typeof agentInfo>;
export type Config = z.infer<typeof config>;
export type Scope = z.infer<typeof scope>;
export type Anchor = z.infer<typeof anchor>;
export type Citation = z.infer<typeof citation>;
export type Turn = z.infer<typeof turn>;
export type ChatRequest = z.infer<typeof chatRequest>;
export interface AssistantBridge {
  repositories(): Promise<Repository[]>;
  addRepository(name: string): Promise<Repository[]>;
  syncRepository(name: string, discover: boolean): Promise<Repository[]>;
  watchAuthors(name: string, authors: string[]): Promise<Repository[]>;
  removeRepository(name: string): Promise<Repository[]>;
  // Called when a notification asks for a pull request to be opened.
  onOpenPr(callback: (url: string) => void): () => void;
  agentSelection(): Promise<AgentCatalog>;
  saveSelection(value: Selection): Promise<AgentCatalog>;
  agentConfig(url: string): Promise<Config>;
  savePrompt(url: string, scope: Scope, prompt: string, purpose?: PromptPurpose): Promise<Config>;
  clearPrompt(url: string, target: Scope, purpose?: PromptPurpose): Promise<Config>;
  assessFinding(value: AssessFinding): Promise<Turn>;
  chooseExecutable(agent: AgentId): Promise<boolean>;
  newConversation(url: string): Promise<void>;
  history(url: string): Promise<Turn[]>;
  ask(request: ChatRequest): Promise<Turn>;
  cancelAsk(run: string): Promise<void>;
  onActivity(callback: (event: z.infer<typeof activity>) => void): () => void;
}
// Local branch reviews have no GitHub repository, so repository-scoped settings do not apply.
export function githubRepoOf(url: string) {
  return isLocalReview(url) ? null : repoOf(url);
}
export function repoOf(url: string) {
  return repoName.parse(
    new URL(pullRequestUrl.parse(url)).pathname.split('/').slice(1, 3).join('/'),
  );
}
export function readableError(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : 'Operation failed. Please retry.';
}
