import { UnconfirmedReply } from './github.js';
import { discussionReply } from '../shared/discussions.js';
import { listDiscussions, sendDiscussionReply } from './discussions.js';
import type { SourceCitation } from '../shared/assistant.js';
import { fileKey, type ReaderView } from '../shared/reader.js';
import { join } from 'node:path';
import { lookupInstructions, prLookups, runWithPrLookups } from './full-pr.js';
import { pinnedSource } from './pr-source.js';
import { webLink } from '../shared/workspace.js';
import { shell, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { reviewPublisher } from './publish.js';
import { bundleKey, editRequest, publishKey } from '../shared/publish.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  repoName,
  login,
  agentId,
  scope,
  selection,
  reviewPrompt,
  chatRequest,
} from '../shared/assistant.js';
import { pullRequestUrl } from '../shared/reviews.js';
import { discover, runAgent } from './agents.js';
import { buildAgentContext, citationInstruction, citedAnswer } from './evidence.js';
import { replyMonitor } from './replies.js';
import { githubLogin } from './account.js';
import { monitor } from './monitor.js';
import type { openStore } from './store.js';

export function registerWorkspace(
  store: ReturnType<typeof openStore>,
  verify: (e: IpcMainInvokeEvent) => void,
  userData: string,
) {
  const data = store.assistant;
  const shutdown = new AbortController();
  const sync = monitor(data, shutdown.signal);
  let catalog: ReturnType<typeof discover> | undefined;
  function agents() {
    return (catalog ??= discover(data).catch((error: unknown) => {
      catalog = undefined;
      throw error;
    }));
  }
  async function config(url: string) {
    const installed = await agents();
    return { agents: installed, ...data.preferences(url, installed[0]?.id ?? 'codex') };
  }
  let active: { id: string; controller: AbortController } | null = null;
  const handle = (name: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      verify(event);
      return fn(event, ...args);
    });
  };
  const account = githubLogin();
  const replies = replyMonitor(store.replies, shutdown.signal);
  handle('settings:type', () => store.typography());
  handle('settings:save-type', (_, value) => store.saveTypography(value));
  handle('account:start', () => {
    replies.invalidate();
    return account.start();
  });
  handle('account:progress', () => account.progress());
  handle('account:cancel', () => account.cancel());
  handle('chat:open-link', (_, value) => shell.openExternal(webLink.parse(value)));
  handle('account:device', () => shell.openExternal('https://github.com/login/device'));
  handle('replies:sync', () =>
    account.progress().state === 'waiting' ? replies.state() : replies.sync(),
  );
  handle('replies:read', async (_, value) => {
    const name = login.parse(value);
    await replies.verify(name);
    store.replies.mark(name);
    return replies.state();
  });
  handle('replies:open', async (_, value, key) => {
    const name = login.parse(value),
      id = z.number().int().positive().parse(key);
    await replies.verify(name);
    await shell.openExternal(store.replies.thread(name, id));
    store.replies.mark(name, id);
    return replies.state();
  });
  handle('reader:full-file', async (_, input) => {
    const key = fileKey.parse(input);
    const view = store.reader.read(key.url);
    const file = view?.files.find((f) => f.path === key.path);
    if (!view || !file || view.revision !== key.revision || store.reader.active() !== key.url)
      throw Error('Reopen the selected file at this revision.');
    if (file.kind === 'binary') throw Error('Binary files have no text view.');
    if (file.kind === 'text' && (file.status === 'added' || file.status === 'removed'))
      return store.reader.patch(key);
    try {
      return await pinnedSource(join(userData, 'pr-source'), key.url).fullFile(
        view.meta.head,
        view.meta.mergeBase,
        file,
        shutdown.signal,
      );
    } catch (e) {
      if (e instanceof Error && !('cmd' in e)) throw e;
      throw Error(
        'Could not load the pinned source. Check Git, your connection, and repository access.',
        { cause: e },
      );
    }
  });
  handle('discussions:list', (_, input) =>
    listDiscussions(pullRequestUrl.parse(input), shutdown.signal, undefined, undefined, true),
  );
  const postingReplies = new Set<string>();
  handle('discussions:reply', async (_, input) => {
    const req = discussionReply.parse(input);
    if (store.reader.active() !== req.url) throw Error('Reopen this PR before replying.');
    const key = JSON.stringify([req.url, req.account, req.kind, req.id]);
    if (postingReplies.has(key)) throw Error('A reply to this discussion is already being posted.');
    postingReplies.add(key);
    try {
      return await sendDiscussionReply(req, shutdown.signal);
    } catch (e) {
      if (e instanceof UnconfirmedReply) throw e;
      throw Error(
        'Reply was not sent. ' + (e instanceof Error ? e.message : 'Refresh discussions.'),
        { cause: e },
      );
    } finally {
      postingReplies.delete(key);
    }
  });
  const publisher = reviewPublisher(store, undefined, undefined, shutdown.signal);
  handle('drafts:list', (_, url) => store.drafts.get(pullRequestUrl.parse(url)));
  handle('drafts:edit', (_, input, request) => {
    const { url, version } = bundleKey.parse(input);
    return publisher.edit(url, version, editRequest.parse(request));
  });
  handle('publish:identity', () => publisher.identity());
  handle('publish:send', (_, input) => publisher.publish(publishKey.parse(input)));
  handle('publish:check', (_, input) => publisher.reconcile(pullRequestUrl.parse(input)));
  handle('publish:reopen', (_, input) => {
    const { url, version } = bundleKey.parse(input);
    return publisher.reconcile(url, true, version);
  });
  handle('publish:receipt', (_, input) => {
    const url = pullRequestUrl.parse(input);
    const id = store.drafts.get(url).receipt;
    if (!id) throw Error('No published review receipt.');
    return shell.openExternal(url + '#pullrequestreview-' + id);
  });
  handle('repos:list', () => data.repositories());
  handle('repos:add', async (_, value) => {
    const name = repoName.parse(value);
    const exists = data.repositories().some((repo) => repo.name === name);
    data.add(name);
    const rows = await sync(name, true);
    const added = rows.find((repo) => repo.name === name);
    if (!exists && added?.error && !added.checked) {
      data.remove(name);
      throw new Error(added.error);
    }
    return rows;
  });
  handle('repos:sync', (_, value, discover) => sync(value, z.boolean().parse(discover)));
  handle('repos:watch', (_, value, authors) => {
    const name = repoName.parse(value);
    data.watch(name, z.array(login).max(2000).parse(authors));
    return sync(name, false);
  });
  handle('repos:remove', (_, value) => {
    data.remove(repoName.parse(value));
    return data.repositories();
  });
  handle('agent:config', (_, url) => config(pullRequestUrl.parse(url)));
  async function chosen() {
    const installed = await agents();
    return { agents: installed, selection: data.selection(installed[0]?.id ?? 'codex') };
  }
  handle('agent:selection', () => chosen());
  handle('agent:select', (_, value) => {
    data.saveSelection(selection.parse(value));
    return chosen();
  });
  handle('agent:save-prompt', async (_, value, target, text) => {
    const url = pullRequestUrl.parse(value);
    data.savePrompt(url, scope.parse(target), reviewPrompt.parse(text));
    return config(url);
  });
  handle('agent:clear-prompt', async (_, value, target) => {
    const url = pullRequestUrl.parse(value);
    data.clearPrompt(url, scope.parse(target));
    return config(url);
  });
  handle('agent:choose', async (_, value) => {
    const id = agentId.parse(value);
    const choice = await dialog.showOpenDialog({
      title: 'Select ' + id + ' executable',
      properties: ['openFile'],
    });
    const path = choice.filePaths[0];
    if (choice.canceled || !path) return false;
    data.setExecutable(id, path);
    catalog = undefined;
    return true;
  });
  function annotated(
    url: string,
    msg: ReturnType<typeof data.history>[number],
    current: ReaderView | null,
  ) {
    if (msg.revision === current?.revision) return msg;
    const { citations } = citedAnswer(msg.answer, msg.citations);
    const paths = [...new Set(citations.map((c) => c.path))];
    const changedEvidence = new Set(
      paths.filter((path) => store.reader.revisions.citationChanged(url, msg.revision, path)),
    );
    for (const ref of msg.sourceCitations ?? []) {
      if (ref.commit !== (ref.side === 'head' ? current?.meta.head : current?.meta.mergeBase))
        changedEvidence.add(ref.path);
    }
    return { ...msg, changedEvidence: [...changedEvidence] };
  }
  handle('chat:history', (_, value) => {
    const url = pullRequestUrl.parse(value);
    const snapshot = store.reader.read(url);
    return data.history(url).map((msg) => annotated(url, msg, snapshot));
  });
  handle('chat:cancel', (_, id) => {
    if (active && active.id === id) active.controller.abort();
  });
  handle('chat:ask', async (event, value) => {
    const req = chatRequest.parse(value);
    if (active) throw new Error('Another answer is running. Cancel it or wait for it to finish.');
    const view = store.reader.read(req.url);
    if (!view || store.reader.active() !== req.url || view.revision !== req.revision)
      throw new Error('Reopen this revision before asking a question.');
    const controller = new AbortController();
    active = { id: req.run, controller };
    try {
      const { agents, settings } = await config(req.url);
      const agent = agents.find((a) => a.id === settings.agent);
      if (!agent) throw new Error('Select an installed agent first.');
      const signal = controller.signal;
      signal.throwIfAborted();
      const patch = (path: string) =>
        store.reader.patch({ url: req.url, path, revision: req.revision });
      const { sources, context } = buildAgentContext(view, req, data.history(req.url), patch);
      const full = req.contextMode === 'full-pr';
      const sourceLines: SourceCitation[] = [];
      const instructions = [
        settings.prompt,
        citationInstruction,
        ...(full ? [lookupInstructions] : []),
      ].join('\n\n');
      const progress = (text: string) => {
        if (!event.sender.isDestroyed()) event.sender.send('chat:activity', { run: req.run, text });
      };
      const ask = (input: string) =>
        runAgent(agent, settings, instructions, input, signal, full ? () => {} : progress);
      const output = full
        ? await runWithPrLookups(
            {
              ...context,
              revisionInfo: {
                head: view.meta.head,
                mergeBase: view.meta.mergeBase,
                base: view.meta.base,
                headBranch: view.meta.headBranch,
                baseBranch: view.meta.baseBranch,
              },
              cachedChangedFiles: view.files.length,
              coverage: {
                partial: view.files.filter((f) => f.kind === 'partial').length,
                unavailable: view.files.filter((f) => f.kind === 'unavailable').length,
                binary: view.files.filter((f) => f.kind === 'binary').length,
              },
            },
            ask,
            prLookups(
              view,
              patch,
              sources,
              pinnedSource(join(userData, 'pr-source'), req.url),
              sourceLines,
              { url: req.url, load: (signal) => listDiscussions(req.url, signal) },
            ),
            signal,
            progress,
          )
        : await ask(JSON.stringify(context));
      controller.signal.throwIfAborted();
      const answer = citedAnswer(output.answer, sources, sourceLines);
      const result = {
        ...answer,
        contextMode: req.contextMode ?? 'focused',
        run: req.run,
        revision: req.revision,
        path: req.path,
        question: req.question,
        settings,
        reportedModel: output.reportedModel,
        promptVersion: createHash('sha256').update(instructions).digest('hex').slice(0, 12),
      };
      data.append(req.url, result);
      return annotated(req.url, result, store.reader.read(req.url));
    } finally {
      active = null;
    }
  });
  return {
    cancel: () => active?.controller.abort(),
    close: () => {
      account.cancel();
      shutdown.abort();
      active?.controller.abort();
    },
  };
}
