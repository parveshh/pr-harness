import { findingsInstructions, readFindings } from './pr-findings.js';
import { assessFinding, draftFindings } from '../shared/findings.js';
import { promptPurpose } from '../shared/assistant.js';
import {
  attemptKey,
  failureKey,
  type AttemptKey,
  type FailureKey,
  type FailureReport,
} from '../shared/failure.js';
import { locateFailure, readFailure } from './check-failures.js';
import {
  candidates,
  changedPulls,
  prepareComparison,
  investigate,
  pairPromptVersion,
} from './cross-pr.js';
import { pairRequest } from '../shared/cross-pr.js';
import { lessonKey, saveLesson } from '../shared/lessons.js';
import { UnconfirmedReply } from './github.js';
import { discussionReply, resolveRequest } from '../shared/discussions.js';
import { listDiscussions, resolveDiscussion, sendDiscussionReply } from './discussions.js';
import type { SourceCitation } from '../shared/assistant.js';
import { fileKey, revisionHead, type ReaderView } from '../shared/reader.js';
import { join } from 'node:path';
import {
  localLookupInstructions,
  lookupInstructions,
  prLookups,
  runWithPrLookups,
} from './full-pr.js';
import { localReviewSource, pinnedRevision } from './local-branch.js';
import { pinnedSource } from './pr-source.js';
import { webLink } from '../shared/workspace.js';
import { shell, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { reviewPublisher } from './publish.js';
import { bundleKey, draftKey, editRequest, publishKey } from '../shared/publish.js';
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
  citedSourceKey,
} from '../shared/assistant.js';
import { isLocalReview, pullRequestUrl, reviewKey } from '../shared/reviews.js';
import { discover, runAgent } from './agents.js';
import { buildAgentContext, citationInstruction, citedAnswer } from './evidence.js';
import { replyMonitor } from './replies.js';
import { githubLogin } from './account.js';
import { monitor } from './monitor.js';
import { requestsToAnnounce, reviewRequestMonitor } from './review-requests.js';
import { chatRuns } from './chat-runs.js';
import { pipelineReader } from './pipelines.js';
import type { PrAlerts } from './pr-alerts.js';
import type { openStore } from './store.js';

export function registerWorkspace(
  store: ReturnType<typeof openStore>,
  verify: (e: IpcMainInvokeEvent) => void,
  userData: string,
  alerts: PrAlerts,
) {
  const data = store.assistant;
  const shutdown = new AbortController();
  const check = monitor(data, shutdown.signal, undefined, undefined, (repo, pulls) =>
    alerts.announce(repo, pulls),
  );
  const requests = reviewRequestMonitor(
    store.reviewRequests,
    shutdown.signal,
    undefined,
    // `requested` shows nothing for an empty list.
    (arrived) => alerts.requested(requestsToAnnounce(arrived, store.reader.active())),
  );
  // The app icon counts new pull requests, so refresh it whenever the list may have changed.
  const badge = () => {
    // The PR on screen has been seen, even if a check has only just listed it as new.
    const open = store.reader.active();
    if (open) {
      data.seen(open);
      store.reviewRequests.seen(open);
    }
    // A monitored PR that also requests the reviewer counts once.
    alerts.badge(new Set([...data.unseenPulls(), ...requests.unseen()]).size);
  };
  const sync = async (...input: Parameters<typeof check>) => {
    try {
      return await check(...input);
    } finally {
      badge();
    }
  };
  badge();
  let catalog: ReturnType<typeof discover> | undefined;
  function agents() {
    return (catalog ??= discover(data).catch((error: unknown) => {
      catalog = undefined;
      throw error;
    }));
  }
  async function config(url: string) {
    const installed = await agents();
    return {
      agents: installed,
      summary: data.summaryPreferences(url),
      ...data.preferences(url, installed[0]?.id ?? 'codex'),
    };
  }
  const runs = chatRuns();
  const handle = (name: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      verify(event);
      return fn(event, ...args);
    });
  };
  type PairSession = {
    run: string;
    repo: string;
    controller: AbortController;
    prepared?: Awaited<ReturnType<typeof prepareComparison>>;
    investigating: boolean;
  };
  let pair: PairSession | undefined;
  function monitored(input: unknown) {
    const name = repoName.parse(input);
    if (!data.repositories().some((r) => r.name === name))
      throw Error('Choose a monitored repository.');
    return name;
  }
  function endPair() {
    pair?.controller.abort();
    pair = undefined;
  }
  function preparedPair(input: unknown) {
    const run = z.uuid().parse(input);
    if (pair?.run !== run || !pair.prepared) throw Error('Reopen the comparison to continue.');
    monitored(pair.repo);
    return { session: pair, prepared: pair.prepared };
  }
  let scan: { run: string; controller: AbortController } | undefined;
  handle('pair:candidates', async (_, input, id) => {
    const repo = monitored(input),
      run = z.uuid().parse(id);
    scan?.controller.abort();
    const controller = new AbortController();
    scan = { run, controller };
    try {
      return await candidates(repo, controller.signal);
    } finally {
      if (scan?.controller === controller) scan = undefined;
    }
  });
  handle('pair:cancel-candidates', (_, id) => {
    if (scan?.run === z.uuid().parse(id)) scan?.controller.abort();
  });
  handle('pair:prepare', async (_, input) => {
    const request = pairRequest.parse(input);
    monitored(request.repo);
    endPair();
    const session: PairSession = {
      run: request.run,
      repo: request.repo,
      controller: new AbortController(),
      investigating: false,
    };
    pair = session;
    try {
      const prepared = await prepareComparison(request, store.reader, session.controller.signal);
      session.controller.signal.throwIfAborted();
      session.prepared = prepared;
      return prepared.summary;
    } catch (error) {
      if (pair === session) endPair();
      throw error;
    }
  });
  handle('pair:check', (_, input) => {
    const { session, prepared } = preparedPair(input);
    return changedPulls(session.repo, prepared.summary, session.controller.signal);
  });
  handle('pair:analyze', async (_, input) => {
    const { session, prepared } = preparedPair(input);
    if (session.investigating) throw Error('This comparison is already running.');
    session.investigating = true;
    try {
      const installed = await agents();
      const selection = data.selection(installed[0]?.id ?? 'codex');
      const agent = installed.find((a) => a.id === selection.agent);
      if (!agent) throw Error('Select an installed coding agent in the title bar and retry.');
      const url = 'https://github.com/' + session.repo + '/pull/' + prepared.summary.left.number;
      const signal = session.controller.signal;
      const source = pinnedSource(join(userData, 'pr-source'), url);
      const result = await investigate(
        prepared,
        (instructions, input) =>
          runAgent(
            agent,
            { ...selection, prompt: instructions },
            instructions,
            input,
            signal,
            () => {},
          ),
        (...args) => source.read(...args),
        signal,
      );
      signal.throwIfAborted();
      return {
        findings: result.findings,
        gaps: result.gaps,
        agent: agent.id,
        run: session.run,
        requestedModel: selection.model,
        reportedModel: result.reportedModel,
        promptVersion: pairPromptVersion,
      };
    } finally {
      session.investigating = false;
    }
  });
  handle('pair:close', (_, input) => {
    if (z.uuid().parse(input) === pair?.run) endPair();
  });
  const account = githubLogin();
  const replies = replyMonitor(
    store.replies,
    shutdown.signal,
    undefined,
    undefined,
    undefined,
    (changes, account) =>
      alerts.reviewChanges(changes, async (events) => {
        await replies.verify(account);
        for (const event of events) store.replies.markChange(account, event.id);
      }),
  );
  handle('settings:type', () => store.typography());
  handle('settings:save-type', (_, value) => store.saveTypography(value));
  handle('account:start', () => {
    replies.invalidate();
    requests.invalidate();
    return account.start();
  });
  handle('account:progress', () => account.progress());
  handle('account:cancel', () => account.cancel());
  handle('chat:open-link', (_, value) => shell.openExternal(webLink.parse(value)));
  handle('account:device', () => shell.openExternal('https://github.com/login/device'));
  handle('replies:sync', async () => {
    if (account.progress().state === 'waiting') return replies.state();
    const inbox = await replies.sync();
    badge();
    return inbox;
  });
  handle('requests:list', () => requests.state());
  handle('requests:sync', async () => {
    if (account.progress().state === 'waiting') return requests.state();
    try {
      await requests.sync();
    } finally {
      badge();
    }
    // Read after the badge refresh, which clears the mark of a PR that is open on screen.
    return requests.state();
  });
  handle('replies:read', async (_, value) => {
    const name = login.parse(value);
    await replies.verify(name);
    store.replies.mark(name);
    store.replies.markChange(name);
    return replies.state();
  });
  handle('replies:read-change', async (_, value, key) => {
    const name = login.parse(value);
    const id = z.number().int().positive().parse(key);
    await replies.verify(name);
    store.replies.markChange(name, id);
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
  handle('reader:cited-source', async (_, input) => {
    const { url, run, id } = citedSourceKey.parse(input);
    if (store.reader.active() !== url) throw Error('Reopen this pull request to view its source.');
    const ref = data.citedSource(url, run, id);
    if (!ref) throw Error('This source is unavailable in the saved answer.');
    if (isLocalReview(url)) {
      const turn = data.history(url).find((t) => t.run === run);
      if (!turn) throw Error('This source is unavailable in the saved answer.');
      // Committed content is read from Git objects. Uncommitted content is served only while
      // the working tree still matches the revision the answer was written for.
      return localReviewSource(store.local, url, {
        revision: turn.revision,
        head: ref.commit,
        mergeBase: ref.commit,
      }).text(ref.commit, ref.path, shutdown.signal, ref.side);
    }
    try {
      return await pinnedSource(join(userData, 'pr-source'), url).text(
        ref.commit,
        ref.path,
        shutdown.signal,
      );
    } catch (cause) {
      throw Error(
        'Could not load the cited file at its saved commit. Check your connection and repository access, then retry.',
        { cause },
      );
    }
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
    if (isLocalReview(key.url))
      return localReviewSource(store.local, key.url, pinnedRevision(view)).fullFile(
        file,
        shutdown.signal,
        file.kind === 'text' ? store.reader.patch(key) : undefined,
      );
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
  // Review threads last listed for each PR. Only those may be resolved from the window.
  const listedThreads = new Map<
    string,
    Map<string, { id: number; path: string | null; resolved: boolean }>
  >();
  handle('discussions:list', async (_, input) => {
    const url = pullRequestUrl.parse(input);
    const result = await listDiscussions(url, shutdown.signal, undefined, undefined, true);
    listedThreads.set(
      url,
      new Map(
        result.threads.flatMap((t) =>
          t.resolution
            ? [
                [
                  t.resolution.node,
                  { id: t.id, path: t.path, resolved: t.resolution.resolved },
                ] as const,
              ]
            : [],
        ),
      ),
    );
    return result;
  });
  function activeLessonReview(input: unknown) {
    const url = pullRequestUrl.parse(input);
    if (store.reader.active() !== url)
      throw Error('Reopen this pull request to access review lessons.');
    return url;
  }
  handle('lessons:list', (_, input) => store.lessons.list(activeLessonReview(input)));
  handle('lessons:save', (_, input) => {
    const request = saveLesson.parse(input);
    const url = activeLessonReview(request.sourceUrl);
    const thread = Array.from(listedThreads.get(url)?.values() ?? []).find(
      (t) => t.id === request.threadId,
    );
    if (!thread?.resolved || !thread.path)
      throw Error('Refresh discussions and choose a resolved file discussion.');
    store.lessons.save({ ...request, path: thread.path });
    return store.lessons.list(url);
  });
  handle('lessons:forget', (_, input, key) => {
    const url = activeLessonReview(input);
    store.lessons.forget(url, lessonKey.parse(key));
    return store.lessons.list(url);
  });
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
  handle('discussions:resolve', async (_, input) => {
    const req = resolveRequest.parse(input);
    if (store.reader.active() !== req.url) throw Error('Reopen this PR before resolving.');
    if (!listedThreads.get(req.url)?.has(req.node))
      throw Error('This conversation is no longer listed. Refresh the discussions.');
    const result = await resolveDiscussion(req, shutdown.signal);
    const thread = listedThreads.get(req.url)?.get(req.node);
    if (thread) thread.resolved = result.resolved;
    return result;
  });
  const readPipelines = pipelineReader();
  handle('pipelines:list', (_, input) => {
    const url = pullRequestUrl.parse(input);
    // Checks are read for the commit under review, which may trail the PR's newest push.
    const head = store.reader.read(url)?.meta.head;
    if (!head) throw Error('Open this PR before checking its pipeline.');
    return readPipelines.read(url, head, shutdown.signal);
  });
  function failureRevision(key: AttemptKey) {
    const view = store.reader.read(key.url);
    if (
      !view ||
      store.reader.active() !== key.url ||
      view.revision !== key.revision ||
      view.meta.head !== key.head
    )
      throw Error('The reviewed revision changed. Reopen Checks to investigate this commit.');
    return view;
  }
  const historyReads = new Map<string, AbortController>();
  handle('pipelines:attempt', async (_, input, id) => {
    const key = attemptKey.parse(input);
    failureRevision(key);
    const session = z.uuid().parse(id);
    const controller = new AbortController();
    historyReads.set(session, controller);
    try {
      const jobs = await readPipelines.attemptJobs(key, controller.signal);
      controller.signal.throwIfAborted();
      failureRevision(key);
      return jobs;
    } finally {
      historyReads.delete(session);
    }
  });
  let failure: { key: FailureKey; controller: AbortController; report?: FailureReport } | undefined;
  let sourceRead: { id: string; controller: AbortController } | undefined;
  function closeSource() {
    sourceRead?.controller.abort();
    sourceRead = undefined;
  }
  function closeFailure() {
    closeSource();
    failure?.controller.abort();
    failure = undefined;
  }
  handle('pipelines:investigate', async (_, input) => {
    const key = failureKey.parse(input);
    failureRevision(key);
    closeFailure();
    const controller = new AbortController();
    failure = { key, controller };
    try {
      const report = await readFailure(key, readPipelines.attemptJobs, controller.signal);
      controller.signal.throwIfAborted();
      failureRevision(key);
      failure.report = report;
      return report;
    } catch (error) {
      if (failure?.controller === controller) closeFailure();
      throw error;
    }
  });
  handle('pipelines:close-location', (_, id) => {
    if (z.uuid().parse(id) === sourceRead?.id) closeSource();
  });
  handle('pipelines:location', async (_, id, value, request) => {
    const session = z.uuid().parse(id),
      index = z.number().int().nonnegative().parse(value);
    if (!failure || failure.key.session !== session)
      throw Error('Reopen the failure to inspect its code.');
    const { key, report } = failure;
    const annotation = report?.annotations[index]?.location;
    if (!annotation) throw Error('Choose an annotation from this job.');
    const view = failureRevision(key);
    const file = view.files.find((f) => f.path === annotation.path && f.status !== 'removed');
    const patch =
      file && (file.kind === 'partial' || file.kind === 'text')
        ? store.reader.patch({ ...key, path: file.path })
        : null;
    const readId = z.uuid().parse(request);
    closeSource();
    const controller = new AbortController();
    sourceRead = { id: readId, controller };
    try {
      const location = await locateFailure(
        annotation,
        key.head,
        patch,
        pinnedSource(join(userData, 'pr-source'), key.url),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      failureRevision(key);
      return location;
    } finally {
      if (sourceRead?.controller === controller) sourceRead = undefined;
    }
  });
  handle('pipelines:close-failure', (_, id) => {
    const session = z.uuid().parse(id);
    historyReads.get(session)?.abort();
    if (session === failure?.key.session) closeFailure();
  });
  const publisher = reviewPublisher(store, undefined, undefined, shutdown.signal);
  handle('drafts:list', (_, url) => store.drafts.get(reviewKey.parse(url)));
  handle('drafts:edit', (_, input, request) => {
    const { url, version } = draftKey.parse(input);
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
    const rows = await sync(name, true, false);
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
    return sync(name, false, false);
  });
  handle('repos:remove', (_, value) => {
    data.remove(repoName.parse(value));
    badge();
    return data.repositories();
  });
  handle('agent:config', (_, url) => config(reviewKey.parse(url)));
  async function chosen() {
    const installed = await agents();
    return { agents: installed, selection: data.selection(installed[0]?.id ?? 'codex') };
  }
  handle('agent:selection', () => chosen());
  handle('agent:select', (_, value) => {
    data.saveSelection(selection.parse(value));
    return chosen();
  });
  handle('agent:save-prompt', async (_, value, target, text, purpose) => {
    const url = reviewKey.parse(value);
    data.savePrompt(
      url,
      scope.parse(target),
      reviewPrompt.parse(text),
      promptPurpose.parse(purpose),
    );
    return config(url);
  });
  handle('agent:clear-prompt', async (_, value, target, purpose) => {
    const url = reviewKey.parse(value);
    data.clearPrompt(url, scope.parse(target), promptPurpose.parse(purpose));
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
    const local = isLocalReview(url);
    for (const ref of msg.sourceCitations ?? []) {
      if (ref.commit !== (ref.side === 'head' ? current?.meta.head : current?.meta.mergeBase))
        changedEvidence.add(ref.path);
      // A local head can stay on one commit while its uncommitted files change.
      else if (
        local &&
        ref.side === 'head' &&
        (!current || revisionHead(msg.revision) !== revisionHead(current.revision))
      )
        changedEvidence.add(ref.path);
    }
    return { ...msg, changedEvidence: [...changedEvidence] };
  }
  handle('chat:new-conversation', (_, value) => {
    const url = reviewKey.parse(value);
    if (store.reader.active() !== url) throw Error('Reopen this review to start a conversation.');
    if (runs.isRunning(url))
      throw Error('Wait for the answer or cancel it before starting a new conversation.');
    data.newConversation(url);
  });
  handle('chat:history', (_, value) => {
    const url = reviewKey.parse(value);
    const snapshot = store.reader.read(url);
    return data.history(url).map((msg) => annotated(url, msg, snapshot));
  });
  handle('chat:assess-finding', (_, value) => store.findings.assess(assessFinding.parse(value)));
  handle('chat:draft-findings', (_, value) => store.findings.draft(draftFindings.parse(value)));
  handle('chat:cancel', (_, id) => runs.cancel(z.uuid().parse(id)));
  handle('chat:ask', async (event, value) => {
    const req = chatRequest.parse(value);
    const view = store.reader.read(req.url);
    if (!view || store.reader.active() !== req.url || view.revision !== req.revision)
      throw new Error('Reopen this revision before asking a question.');
    const signal = runs.begin(req.url, req.run);
    try {
      const generation = data.generation(req.url);
      const configForRun = await config(req.url);
      const { agents } = configForRun;
      const settings =
        req.kind === 'summary'
          ? { ...configForRun.settings, prompt: configForRun.summary.prompt }
          : configForRun.settings;
      const agent = agents.find((a) => a.id === settings.agent);
      if (!agent) throw new Error('Select an installed agent first.');
      signal.throwIfAborted();
      const patch = (path: string) =>
        store.reader.patch({ url: req.url, path, revision: req.revision });
      const { sources, context } = buildAgentContext(
        view,
        req,
        data.history(req.url, generation),
        patch,
      );
      const full = req.kind === 'review' || req.kind === 'summary' || req.contextMode === 'full-pr';
      const local = isLocalReview(req.url);
      const sourceLines: SourceCitation[] = [];
      const instructions = [
        settings.prompt,
        citationInstruction,
        ...(full ? [lookupInstructions] : []),
        ...(full && local ? [localLookupInstructions] : []),
        ...(req.kind === 'review' ? [findingsInstructions] : []),
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
              local
                ? localReviewSource(store.local, req.url, pinnedRevision(view))
                : pinnedSource(join(userData, 'pr-source'), req.url),
              sourceLines,
              local ? null : { url: req.url, load: (signal) => listDiscussions(req.url, signal) },
            ),
            signal,
            progress,
          )
        : await ask(JSON.stringify(context));
      signal.throwIfAborted();
      const review = req.kind === 'review' ? readFindings(output.answer, sources, patch) : null;
      const answer = citedAnswer(review?.coverage ?? output.answer, sources, sourceLines);
      const result = {
        ...answer,
        ...(review && { findings: review.findings }),
        contextMode: full ? ('full-pr' as const) : ('focused' as const),
        run: req.run,
        revision: req.revision,
        path: req.path,
        question: req.question,
        settings,
        reportedModel: output.reportedModel,
        promptVersion: createHash('sha256').update(instructions).digest('hex').slice(0, 12),
      };
      const saved = data.append(req.url, result, generation);
      return annotated(req.url, saved, store.reader.read(req.url));
    } finally {
      runs.end(req.url, req.run);
    }
  });
  return {
    // Opening a PR clears its new mark.
    seen(url: string) {
      data.seen(url);
      store.reviewRequests.seen(url);
      badge();
    },
    cancel: () => {
      for (const read of historyReads.values()) read.abort();
      closeFailure();
      scan?.controller.abort();
      endPair();
      runs.cancelAll();
    },
    close: () => {
      account.cancel();
      for (const read of historyReads.values()) read.abort();
      closeFailure();
      scan?.controller.abort();
      endPair();
      shutdown.abort();
      runs.cancelAll();
    },
  };
}
