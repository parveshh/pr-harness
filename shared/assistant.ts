import { z } from 'zod';
import { pullRequestUrl } from './reviews.js';

export const defaultPrompt =
  'Answer the reviewer’s question directly. When asked for a file overview, describe what a newly added file introduces and how it fits into the PR, or explain how an existing file’s behaviour changed. Cite the file and lines for each material claim. For a possible defect, describe the triggering conditions and the effect on the caller. If the answer depends on missing evidence, name what you would inspect. Treat the author’s stated intent as a claim to check. Keep routine changes brief.';
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
export const agentId = z.enum(['codex', 'claude']);
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
export const config = z.object({ agents: z.array(agentInfo), settings: prefs, scope });
export const agentCatalog = z.object({ agents: z.array(agentInfo), selection });
export const agentNames = { codex: 'Codex CLI', claude: 'Claude Code' } as const;
export const summaryQuestion =
  'Summarise this whole pull request. State its purpose, then the main behaviour changes grouped by area, the riskiest changes to read first, and any gaps in the tests. List changed files you did not inspect.';
export const anchor = z.object({
  path: z.string(),
  hunk: z.number().int().nonnegative(),
  side: z.enum(['old', 'new']),
  line: z.number().int().positive(),
});
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
export type SourceCitation = z.infer<typeof sourceCitation>;
export const chatRequest = z.object({
  contextMode: contextMode.optional(),
  run: z.uuid(),
  url: pullRequestUrl,
  revision: z.string(),
  path: z.string(),
  hunk: z.number().int().nonnegative(),
  selection: anchor.nullable(),
  extra: z.string().nullable(),
  question: z.string().trim().min(1).max(8000),
});
export const turn = z.object({
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
  number: z.number().int().positive(),
  title: z.string(),
  author: login,
  // Whether the signed-in reviewer's latest review on GitHub approves the PR.
  approved: z.boolean().default(false),
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
  agentSelection(): Promise<AgentCatalog>;
  saveSelection(value: Selection): Promise<AgentCatalog>;
  agentConfig(url: string): Promise<Config>;
  savePrompt(url: string, scope: Scope, prompt: string): Promise<Config>;
  clearPrompt(url: string, target: Scope): Promise<Config>;
  chooseExecutable(agent: AgentId): Promise<boolean>;
  history(url: string): Promise<Turn[]>;
  ask(request: ChatRequest): Promise<Turn>;
  cancelAsk(run: string): Promise<void>;
  onActivity(callback: (event: z.infer<typeof activity>) => void): () => void;
}
export function repoOf(url: string) {
  return repoName.parse(
    pullRequestUrl.parse(url).slice('https://github.com/'.length).split('/pull/')[0],
  );
}
export function readableError(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : 'Operation failed. Please retry.';
}
