import { useCommentDrag } from './useCommentDrag.js';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './components/Resizable.js';
import { PinnedQuestions, QuestionLinks, type QuestionPanel } from './PinnedQuestions.js';
import { RevisionChanges } from './RevisionChanges.js';
import { InlineComments } from './InlineComments.js';
import { Fragment } from 'react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReaderFile, ReaderView } from '../../shared/reader.js';
import { splitHunks } from '../../shared/reader.js';
import { diffLines } from '../../shared/diff.js';
import { highlightRows, languageFor } from '../../shared/highlight.js';
import { CodeLine } from './components/CodeLine.js';
import './reader.css';
import { DraftReview, type DraftEditor } from './DraftReview.js';
import type { Bundle, Draft, CommentAnchor } from '../../shared/publish.js';
import {
  ArrowLeft,
  GitPullRequest,
  GitBranch,
  GitCommitHorizontal,
  UserRound,
  RotateCw,
  FileCode2,
  Files,
  Pin,
  MessageSquarePlus,
  MessageSquare,
} from 'lucide-react';
import { FullFile, type FileFocus } from './FullFile.js';
import { usePrDiscussions, discussionsByLine } from './PrDiscussions.js';
import { ReviewChat } from './ReviewChat.js';
import { PipelineStatus } from './Pipelines.js';
import type { AgentCatalog, Anchor } from '../../shared/assistant.js';

type Position = Pick<ReaderFile, 'hunk' | 'scroll' | 'reviewed'>;
function message(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : 'Could not load this review.';
}

// An action chosen on a PR's sidebar row, carried out once that PR is open.
export type PrCommand = { id: number; url: string; kind: 'summarise' | 'approve' };

export function Reader({
  url,
  onBack,
  headerAction,
  agents,
  command,
  onPublished,
  accountEpoch,
}: {
  url: string;
  onBack: () => void;
  headerAction: ReactNode;
  agents: AgentCatalog | null;
  command: PrCommand | null;
  onPublished: () => void;
  accountEpoch: string | null;
}) {
  const [fullFile, setFullFile] = useState(false);
  const [fullFocus, setFullFocus] = useState<(FileFocus & { path: string }) | null>(null);
  const diffPanel = useRef<HTMLElement>(null);
  const [inlineIds, setInlineIds] = useState(new Set<number>());
  const registerThread = useCallback((id: number, mounted: boolean) => {
    setInlineIds((prev) => {
      if (prev.has(id) === mounted) return prev;
      const next = new Set(prev);
      if (mounted) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [view, setView] = useState<ReaderView | null>(null);
  const discussions = usePrDiscussions(url, view?.revision, accountEpoch);
  const [line, setLine] = useState<(CommentAnchor & { revision: string }) | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [editor, setEditor] = useState<DraftEditor | null>(null);
  const [paneName, setPaneName] = useState<'files' | 'diff' | 'chat'>('diff');
  // Each sidebar command becomes a one-shot request for the pane that carries it out.
  const [seenCommand, setSeenCommand] = useState<number | null>(null);
  const [summaryRequest, setSummaryRequest] = useState<number | null>(null);
  const [approveRequest, setApproveRequest] = useState<number | null>(null);
  if (command && command.id !== seenCommand) {
    setSeenCommand(command.id);
    if (command.kind === 'summarise') {
      setSummaryRequest(command.id);
      setPaneName('chat');
    } else setApproveRequest(command.id);
  }
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of discussions.data?.threads ?? [])
      if (thread.kind === 'inline' && thread.path)
        counts.set(thread.path, (counts.get(thread.path) ?? 0) + thread.messages.length);
    return counts;
  }, [discussions.data]);
  const rangeOrigin = useRef<(Anchor & { revision: string }) | null>(null);
  const [rangeHint, setRangeHint] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [questionPanel, setQuestionPanel] = useState<QuestionPanel | null>(null);
  const questions = view?.questions ?? [];
  const inspectQuestion = (id: string) => setQuestionPanel({ kind: 'inspect', id });
  const since = !!view?.since;
  function showComparison(enabled: boolean, path = view?.changePath ?? null) {
    if (!view?.comparison) return;
    setView((v) =>
      v && v.revision === view.revision ? { ...v, since: enabled, changePath: path } : v,
    );
    window.reviewer
      .comparisonPosition(url, view.revision, enabled, path)
      .catch((e) => setSaveError(message(e)));
  }
  const [transition, setTransition] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let live = true;
    window.reviewer
      .reviewDrafts(url)
      .then((value) => {
        if (live) setBundle(value);
      })
      .catch((e) => {
        if (live) setSaveError(message(e));
      });
    return () => {
      live = false;
    };
  }, [url]);
  useEffect(() => {
    let live = true;
    async function open() {
      const cached = await window.reviewer.cachedReview(url);
      if (!live) return;
      if (cached) setView(cached);
      const fresh = await window.reviewer.refreshReview(url);
      if (live && fresh) {
        setView(fresh);
        if (!fresh.incoming) setGeneration((n) => n + 1);
      }
    }
    open()
      .catch((cause: unknown) => {
        if (live) setError(message(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [url, attempt]);

  const hasView = !!view;
  useEffect(() => {
    if (loading || transition || !hasView) return;
    let live = true,
      checking = false,
      nextCheck = 0,
      delay = 60000;
    async function check() {
      if (checking || document.hidden || !document.hasFocus() || Date.now() < nextCheck) return;
      checking = true;
      try {
        const incoming = await window.reviewer.checkUpdate(url);
        if (live) setView((v) => (v && v.incoming !== incoming ? { ...v, incoming } : v));
        delay = 60000;
      } catch {
        delay = Math.min(delay * 2, 15 * 60000);
      } finally {
        nextCheck = Date.now() + delay;
        checking = false;
      }
    }
    const trigger = () => {
      void check();
    };
    window.addEventListener('focus', trigger);
    const timer = window.setInterval(trigger, 60000);
    return () => {
      live = false;
      window.removeEventListener('focus', trigger);
      window.clearInterval(timer);
    };
  }, [url, loading, transition, hasView]);
  async function changeRevision(open: boolean) {
    if (!view || transition) return;
    setTransition(true);
    try {
      const next =
        open && view.incoming
          ? await window.reviewer.openUpdate(url, view.incoming)
          : await window.reviewer.finishRevision(url, view.revision);
      setView(next);

      if (open) {
        setLine(null);
        setEditor(null);
        setRangeHint('');
        rangeOrigin.current = null;
      }
      setBundle(await window.reviewer.reviewDrafts(url));
      setError('');
    } catch (e) {
      setError(message(e));
    } finally {
      setTransition(false);
    }
  }
  const move = useCallback(
    (file: ReaderFile, change: Partial<Position> = {}) => {
      if (!view) return;
      const updated = { ...file, ...change };
      if (change.reviewed !== undefined) delete updated.needsReview;
      setView((current) =>
        current && current.revision === view.revision
          ? {
              ...current,
              selected: file.path,
              files: current.files.map((f) => (f.path === file.path ? updated : f)),
            }
          : current,
      );
      window.reviewer
        .remember({
          url,
          revision: view.revision,
          path: file.path,
          hunk: updated.hunk,
          scroll: updated.scroll,
          reviewed: updated.reviewed,
        })
        .catch(() =>
          setSaveError(
            'Could not save your reading position. Refresh to recover the last saved position.',
          ),
        );
    },
    [url, view],
  );
  const files = view?.files ?? [];
  const selected = files.find((file) => file.path === view?.selected);
  const threadsByLine = useMemo(
    () => discussionsByLine(discussions.data, view?.meta, selected?.path),
    [discussions.data, view?.meta, selected?.path],
  );
  const renderThreads = (old: number | null, current: number | null) => {
    const left = old === null ? undefined : threadsByLine.get('LEFT:' + old);
    const right = current === null ? undefined : threadsByLine.get('RIGHT:' + current);
    if (!left && !right) return null;
    return (
      <div className="published-threads">
        {left?.map((t) => (
          <InlinePlacement key={t.id} id={t.id} register={registerThread}>
            {discussions.renderThread(t)}
          </InlinePlacement>
        ))}
        {right?.map((t) => (
          <InlinePlacement key={t.id} id={t.id} register={registerThread}>
            {discussions.renderThread(t)}
          </InlinePlacement>
        ))}
      </div>
    );
  };
  const showFullFile = fullFile && selected?.kind !== 'binary';
  const selection =
    line &&
    line.revision === view?.revision &&
    line.path === selected?.path &&
    line.hunk === selected.hunk
      ? line
      : null;
  const index = selected ? files.indexOf(selected) : -1;
  const reviewedCount = files.filter((file) => file.reviewed).length;
  const nextUnread = [...files.slice(index + 1), ...files.slice(0, index)].find(
    (file) => !file.reviewed,
  );
  const visiblePane = !selected && paneName === 'chat' ? 'diff' : paneName;
  function selectLine(anchor: Anchor, extend: boolean) {
    if (!view) return;
    const origin = rangeOrigin.current;
    if (
      extend &&
      origin &&
      origin.path === anchor.path &&
      origin.hunk === anchor.hunk &&
      origin.revision === view.revision
    ) {
      if (origin.side !== anchor.side) {
        setRangeHint('Choose both ends on the same side of the diff.');
        return;
      }
      setLine({
        ...anchor,
        revision: view.revision,
        startLine: Math.min(origin.line, anchor.line),
        line: Math.max(origin.line, anchor.line),
      });
    } else {
      rangeOrigin.current = { ...anchor, revision: view.revision };
      setLine(rangeOrigin.current);
    }
    setRangeHint('');
  }
  return (
    <div className="reader">
      <header>
        <button className="back" onClick={onBack}>
          <ArrowLeft size={15} /> Workspace
        </button>
        <span className="repo">
          <GitPullRequest size={15} />
          {new URL(url).pathname.split('/').slice(1, 3).join('/')}{' '}
          <b>#{new URL(url).pathname.split('/').at(-1)}</b>
        </span>
        <button
          className="refresh"
          disabled={loading}
          onClick={() => {
            setError('');
            setSaveError('');
            setLoading(true);
            setAttempt((n) => n + 1);
            discussions.reload();
          }}
        >
          <RotateCw size={14} /> Refresh
        </button>
        {questions.length > 0 && (
          <button
            className="secondary pins-trigger"
            onClick={() => setQuestionPanel({ kind: 'list' })}
          >
            <Pin size={14} />
            <span>Pinned questions</span> {questions.filter((q) => !q.addressed).length}
          </button>
        )}
        {view && <PipelineStatus url={url} head={view.meta.head} />}
        {headerAction}
      </header>
      {view && questionPanel && (
        <PinnedQuestions
          key={questionPanel.kind === 'list' ? 'list' : questionPanel.kind + questionPanel.id}
          url={url}
          revision={view.revision}
          panel={questionPanel}
          questions={questions}
          show={setQuestionPanel}
          close={() => setQuestionPanel(null)}
          onChange={(updated) =>
            setView((current) =>
              current?.revision === view.revision ? { ...current, questions: updated } : current,
            )
          }
          jump={(path, hunk) => {
            const f = view.files.find((f) => f.path === path);
            if (f) {
              setFullFile(false);
              move(f, { hunk: hunk ?? f.hunk, scroll: 0 });
              showComparison(false);
              setPaneName('diff');
              setQuestionPanel(null);
            }
          }}
        />
      )}
      <main>
        <div className="pr-heading">
          <div className="overview">
            <h1>{view?.meta.title ?? 'Pull request'}</h1>
            {view && (
              <div className="pr-meta">
                <span>
                  <UserRound size={13} />
                  {view.meta.author}
                </span>
                <span>
                  <GitBranch size={13} />
                  <code>
                    {view.meta.headBranch} → {view.meta.baseBranch}
                  </code>
                </span>
                <span title={view.meta.head}>
                  <GitCommitHorizontal size={14} />
                  <code>{view.meta.head.slice(0, 8)}</code>
                </span>
              </div>
            )}
            {view?.meta.description && (
              <details>
                <summary>PR description</summary>
                <p className="description">{view.meta.description}</p>
              </details>
            )}
            {view && discussions.overview(view, inlineIds)}
          </div>
          {view && bundle && (
            <DraftReview
              url={url}
              view={view}
              bundle={bundle}
              approveRequest={approveRequest}
              onChange={(b) => {
                setBundle(b);
                if (b.receipt && b.receipt !== bundle.receipt) onPublished();
                if (b.receipt && b.receipt !== bundle.receipt)
                  window.reviewer
                    .cachedReview(url)
                    .then((v) => {
                      if (v) setView(v);
                    })
                    .catch((e) => setSaveError(message(e)));
              }}
              selection={since ? null : selection}
            />
          )}
        </div>
        {loading && (
          <p role="status">
            {view ? 'Checking GitHub for updates…' : 'Fetching pull request from GitHub…'}
          </p>
        )}
        {error && (
          <p role="alert">
            {error} {view && 'Showing the saved revision.'}
          </p>
        )}
        {saveError && <p role="alert">{saveError}</p>}
        {view && files.length < view.meta.totalFiles && (
          <p role="status">
            Showing {files.length} of {view.meta.totalFiles} changed files. GitHub returned a
            partial file list.
          </p>
        )}
        {view?.incoming && (
          <div className="revision-toolbar" role="status">
            <strong>PR update available</strong>
            <code>{view.incoming.split('...').at(-1)?.slice(0, 8)}</code>
            <button
              disabled={transition || loading || !!editor}
              title={editor ? 'Save or close your inline draft first' : undefined}
              onClick={() => void changeRevision(true)}
            >
              Open update
            </button>
          </div>
        )}
        {view?.comparison && (
          <div className="revision-toolbar" aria-label="Comparison view">
            <button aria-pressed={!since} onClick={() => showComparison(false)}>
              Full PR
            </button>
            <button aria-pressed={since} onClick={() => showComparison(true)}>
              Since my last review
            </button>
            <button
              className="secondary"
              disabled={transition || loading || !!view.incoming}
              onClick={() => void changeRevision(false)}
            >
              Save review checkpoint
            </button>
          </div>
        )}
        {view && since && view.comparison && (
          <RevisionChanges
            key={view.revision}
            url={url}
            view={view}
            comparison={view.comparison}
            inspectQuestion={inspectQuestion}
            choose={(p) => showComparison(true, p)}
            mark={(f) => move(f, { reviewed: !f.reviewed })}
            markAbsent={(path, reviewed) => {
              window.reviewer
                .markComparisonFile({ url, revision: view.revision, path }, reviewed)
                .then((next) =>
                  setView((v) =>
                    v?.revision === next.revision ? { ...v, comparison: next.comparison } : v,
                  ),
                )
                .catch((e) => setSaveError(message(e)));
            }}
            openFile={(f) => {
              move(f);
              setPaneName('diff');
              showComparison(false);
            }}
          />
        )}
        {view && (
          <div className="full-review" hidden={since && !!view.comparison}>
            <div className="pane-switch" aria-label="Review panes">
              {(['files', 'diff', 'chat'] as const).map((name) => (
                <button
                  key={name}
                  disabled={name === 'chat' && !selected}
                  aria-pressed={visiblePane === name}
                  onClick={() => setPaneName(name)}
                >
                  {name === 'files' ? 'Files' : name === 'diff' ? 'Diff' : 'Chat'}
                </button>
              ))}
            </div>
            <ResizablePanelGroup
              id={selected ? 'review-layout' : 'empty-review-layout'}
              className="reading-grid"
              data-pane={visiblePane}
            >
              <ResizablePanel id="review-files" defaultSize="18%" minSize="145px">
                <nav aria-label="Changed files">
                  <div className="nav-heading">
                    <h2>
                      <Files size={15} /> Changed files
                    </h2>
                    <span>
                      {reviewedCount}/{files.length} reviewed
                    </span>
                    <progress
                      aria-label="Files reviewed"
                      value={reviewedCount}
                      max={Math.max(1, files.length)}
                    />
                  </div>
                  <div className="files-scroll">
                    {files.map((f) => {
                      const comments = commentCounts.get(f.path) ?? 0;
                      const commentLabel = comments + (comments === 1 ? ' comment' : ' comments');
                      return (
                        <button
                          key={f.path}
                          className="file-row"
                          aria-label={
                            f.path +
                            ', ' +
                            f.status +
                            (f.reviewed ? ', reviewed' : '') +
                            (comments ? ', ' + commentLabel : '')
                          }
                          title={f.path}
                          aria-current={f.path === selected?.path ? 'true' : undefined}
                          onClick={() => {
                            move(f);
                            setPaneName('diff');
                          }}
                        >
                          <span className={'change-tag ' + f.status} title={f.status}>
                            {f.status.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="file-path">
                            <strong>{f.path.split('/').at(-1)}</strong>
                            {f.path.includes('/') && (
                              <small>{f.path.slice(0, f.path.lastIndexOf('/') + 1)}</small>
                            )}
                          </span>
                          {f.needsReview && <small>Needs another look</small>}
                          {comments > 0 && (
                            <span className="file-comments" title={commentLabel + ' on GitHub'}>
                              <MessageSquare size={12} /> {comments}
                            </span>
                          )}
                          {f.reviewed && <span aria-label="Reviewed">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </nav>
              </ResizablePanel>
              <ResizableHandle label="Resize files and diff" />
              <ResizablePanel id="review-diff" minSize="300px">
                {selected ? (
                  <article ref={diffPanel}>
                    <div className="file-heading">
                      <h2>
                        <FileCode2 size={16} />
                        {selected.path}
                      </h2>
                      <p>
                        {selected.status}{' '}
                        {selected.previousPath && (
                          <>
                            from <code>{selected.previousPath}</code>
                          </>
                        )}{' '}
                        <span className="plus">+{selected.additions}</span>{' '}
                        <span className="minus">−{selected.deletions}</span>
                      </p>
                    </div>
                    <div className="file-view-toggle" role="group" aria-label="File view">
                      <button aria-pressed={!showFullFile} onClick={() => setFullFile(false)}>
                        Diff only
                      </button>
                      <button
                        aria-pressed={showFullFile}
                        disabled={selected.kind === 'binary'}
                        onClick={() => {
                          const pane = diffPanel.current?.querySelector('.diff-scroll');
                          const top = pane?.getBoundingClientRect().top ?? 0;
                          const row = pane
                            ? Array.from(pane.querySelectorAll<HTMLElement>('.diff-line')).find(
                                (r) => r.getBoundingClientRect().bottom > top,
                              )
                            : undefined;
                          const focus =
                            selection ??
                            (row?.dataset.newLine
                              ? { side: 'new' as const, line: Number(row.dataset.newLine) }
                              : row?.dataset.oldLine
                                ? { side: 'old' as const, line: Number(row.dataset.oldLine) }
                                : null);
                          setFullFocus(focus ? { ...focus, path: selected.path } : null);
                          setFullFile(true);
                        }}
                      >
                        Full file
                      </button>
                    </div>
                    {discussions.error && (
                      <div className="discussion-error" role="status">
                        {discussions.error}{' '}
                        <button disabled={discussions.posting} onClick={discussions.reload}>
                          Refresh threads
                        </button>
                      </div>
                    )}
                    {showFullFile ? (
                      <FullFile
                        key={JSON.stringify([view.revision, selected.path])}
                        url={url}
                        revision={view.revision}
                        path={selected.path}
                        discussions={renderThreads}
                        focus={fullFocus?.path === selected.path ? fullFocus : null}
                      />
                    ) : (
                      <Patch
                        key={JSON.stringify([generation, view.revision, selected.path])}
                        url={url}
                        revision={view.revision}
                        file={selected}
                        pinQuestion={() =>
                          setQuestionPanel({
                            kind: 'new',
                            id: crypto.randomUUID(),
                            revision: view.revision,
                            path: selected.path,
                            hunk: selected.hunk,
                          })
                        }
                        pinnedLinks={
                          <QuestionLinks
                            questions={questions.filter(
                              (q) =>
                                !q.addressed &&
                                q.current?.path === selected.path &&
                                q.current.hunk === selected.hunk,
                            )}
                            inspect={inspectQuestion}
                          />
                        }
                        drafts={
                          bundle?.comments.filter(
                            (d) =>
                              d.revision === view.revision &&
                              d.path === selected.path &&
                              d.hunk === selected.hunk,
                          ) ?? []
                        }
                        compose={
                          bundle && !bundle.pending
                            ? (anchor, excerpt, draft) => {
                                setLine({ ...anchor, revision: view.revision });
                                setEditor({
                                  id: draft?.id ?? null,
                                  target: draft ? null : { ...anchor, revision: view.revision },
                                  location: anchor,
                                  body: draft?.body ?? '',
                                  excerpt,
                                });
                              }
                            : undefined
                        }
                        selection={selection}
                        onLine={selectLine}
                        notes={(oldLine, newLine, comments) => {
                          if (!editor && !comments.length) return null;
                          if (!bundle) return null;
                          const matches = (a: CommentAnchor) =>
                            a.path === selected.path &&
                            a.hunk === selected.hunk &&
                            a.line === (a.side === 'old' ? oldLine : newLine);

                          const editing =
                            editor &&
                            matches(editor.location) &&
                            (editor.target?.revision ??
                              bundle.comments.find((c) => c.id === editor.id)?.revision) ===
                              view.revision
                              ? editor
                              : null;
                          if (!editing && !comments.length) return null;
                          return (
                            <InlineComments
                              url={url}
                              bundle={bundle}
                              comments={comments}
                              editor={editing}
                              setEditor={setEditor}
                              onClose={() => {
                                setEditor((current) => (current === editing ? null : current));
                                const a = editing?.location;
                                if (a)
                                  document
                                    .querySelector<HTMLButtonElement>(
                                      '[aria-label="Select ' + a.side + ' line ' + a.line + '"]',
                                    )
                                    ?.focus({ preventScroll: true });
                              }}
                              onChange={setBundle}
                            />
                          );
                        }}
                        published={renderThreads}
                        move={move}
                      />
                    )}
                    {rangeHint && (
                      <small role="status" className="range-hint">
                        {rangeHint}
                      </small>
                    )}
                    <div className="file-actions">
                      <button
                        className="secondary line-comment"
                        disabled={!selection || !bundle || !!bundle.pending}
                        title="Select a line number. Shift-click another number for a range."
                        onClick={() => {
                          setFullFile(false);
                          if (selection)
                            setEditor({
                              id: null,
                              target: { ...selection, revision: view.revision },
                              location: selection,
                              body: '',
                              excerpt: '',
                            });
                        }}
                      >
                        <MessageSquarePlus size={14} />{' '}
                        {selection?.startLine && selection.startLine !== selection.line
                          ? 'Comment on lines ' + selection.startLine + '–' + selection.line
                          : 'Comment on line'}
                      </button>
                      <button
                        aria-pressed={selected.reviewed}
                        onClick={() => move(selected, { reviewed: !selected.reviewed })}
                      >
                        {selected.reviewed ? 'Reviewed ✓' : 'Mark reviewed'}
                      </button>
                      <button
                        className="secondary"
                        disabled={!nextUnread}
                        onClick={() => {
                          if (nextUnread) move(nextUnread);
                        }}
                      >
                        Next unread →
                      </button>
                    </div>
                  </article>
                ) : (
                  <p>No changed files to display.</p>
                )}
              </ResizablePanel>
              {selected && (
                <>
                  {' '}
                  <ResizableHandle label="Resize diff and chat" />
                  <ResizablePanel id="review-chat" defaultSize="28%" minSize="235px">
                    <ReviewChat
                      agents={agents}
                      summaryRequest={summaryRequest}
                      onSummaryStarted={() => setSummaryRequest(null)}
                      url={url}
                      view={view}
                      file={selected}
                      selection={selection}
                      onDraft={
                        bundle && !bundle.pending
                          ? (cite, body) => {
                              const target = files.find((f) => f.path === cite.path);
                              if (!target) return;
                              setFullFile(false);
                              setPaneName('diff');
                              move(target, { hunk: cite.hunk, scroll: 0 });
                              setLine({ ...cite, revision: view.revision });
                              setEditor({
                                id: null,
                                target: { ...cite, revision: view.revision },
                                location: cite,
                                body,
                                excerpt: cite.excerpt,
                              });
                            }
                          : undefined
                      }
                      jump={(cite) => {
                        const target = files.find((f) => f.path === cite.path);
                        if (target) {
                          setFullFile(false);
                          setPaneName('diff');
                          move(target, { hunk: cite.hunk, scroll: 0 });
                          setLine({ ...cite, revision: view.revision });
                        }
                      }}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </div>
        )}
      </main>
    </div>
  );
}

function InlinePlacement({
  id,
  register,
  children,
}: {
  id: number;
  register: (id: number, mounted: boolean) => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    register(id, true);
    return () => register(id, false);
  }, [id, register]);
  return children;
}

type Published = (oldLine: number | null, newLine: number | null) => ReactNode;
type Notes = (oldLine: number | null, newLine: number | null, comments: Draft[]) => ReactNode;
type Compose = ((anchor: CommentAnchor, excerpt: string, draft?: Draft) => void) | undefined;
type Move = (file: ReaderFile, change: Partial<Position>) => void;
function Patch({
  pinQuestion,
  pinnedLinks,
  url,
  revision,
  file,
  drafts,
  compose,
  notes,
  published,
  selection,
  onLine,
  move,
}: {
  url: string;
  revision: string;
  file: ReaderFile;
  pinQuestion: () => void;
  pinnedLinks: ReactNode;
  drafts: Draft[];
  compose: Compose;
  notes: Notes;
  published: Published;
  move: Move;
  selection: CommentAnchor | null;
  onLine: (a: Anchor, extend: boolean) => void;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const hasText = file.kind === 'text' || file.kind === 'partial';
  useEffect(() => {
    let live = true;
    if (hasText)
      window.reviewer
        .filePatch({ url, revision, path: file.path })
        .then((text) => {
          if (live) setPatch(text);
        })
        .catch(() => {
          if (live) setError(true);
        });
    return () => {
      live = false;
    };
  }, [url, revision, file.path, hasText]);
  const hunks = useMemo(() => splitHunks(patch ?? ''), [patch]);
  if (!hasText)
    return (
      <p className="patch-note">
        {file.kind === 'binary'
          ? 'Binary file. A line diff is unavailable.'
          : file.kind === 'metadata'
            ? 'File metadata changed. There are no changed text lines.'
            : 'GitHub did not provide a diff for this file.'}
      </p>
    );
  if (error) return <p role="alert">Could not read this saved diff. Refresh to try again.</p>;
  const hunk = hunks[file.hunk];
  if (hunk === undefined) return <p role="status">Loading diff…</p>;
  return (
    <>
      {file.kind === 'partial' && <p role="status">GitHub supplied only part of this diff.</p>}
      <div className="hunk-nav">
        <span>
          Hunk {file.hunk + 1} of {hunks.length}
        </span>
        <button className="secondary" onClick={pinQuestion}>
          <Pin size={13} /> Pin question
        </button>
        <button
          className="secondary"
          disabled={file.hunk === 0}
          onClick={() => move(file, { hunk: file.hunk - 1, scroll: 0 })}
        >
          Previous hunk
        </button>
        <button
          className="secondary"
          disabled={file.hunk + 1 >= hunks.length}
          onClick={() => move(file, { hunk: file.hunk + 1, scroll: 0 })}
        >
          Next hunk
        </button>
      </div>
      {pinnedLinks}
      <Hunk
        key={file.hunk}
        notes={notes}
        published={published}
        onRange={(range) => compose?.({ path: file.path, hunk: file.hunk, ...range }, '')}
        drafts={drafts}
        onComment={
          compose
            ? (side, line, excerpt, draft) =>
                compose(
                  draft ??
                    (selection &&
                    selection.side === side &&
                    line >= (selection.startLine ?? selection.line) &&
                    line <= selection.line
                      ? selection
                      : { path: file.path, hunk: file.hunk, side, line }),
                  excerpt,
                  draft,
                )
            : undefined
        }
        selection={selection}
        onLine={(side, line, extend) =>
          onLine({ path: file.path, hunk: file.hunk, side, line }, extend)
        }
        text={hunk}
        path={file.path}
        offset={file.scroll}
        onScroll={(scroll) => move(file, { scroll })}
      />
    </>
  );
}

function Hunk({
  text,
  path,
  offset,
  notes,
  published,
  drafts,
  onComment,
  onRange,
  selection,
  onLine,
  onScroll,
}: {
  text: string;
  path: string;
  offset: number;
  notes: Notes;
  published: Published;
  drafts: Draft[];
  onRange: (range: Pick<CommentAnchor, 'side' | 'line' | 'startLine'>) => void;
  onComment:
    ((side: Anchor['side'], line: number, excerpt: string, draft?: Draft) => void) | undefined;
  selection: CommentAnchor | null;
  onLine: (side: Anchor['side'], line: number, extend: boolean) => void;
  onScroll: (n: number) => void;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const drag = useCommentDrag(pane, onRange);
  const highlighted = drag.preview ?? selection;
  const initial = useRef(offset);
  useLayoutEffect(() => {
    if (pane.current) pane.current.scrollTop = initial.current;
  }, []);
  useLayoutEffect(() => {
    const composer = pane.current?.querySelector('.inline-composer textarea:focus');
    if (composer) composer.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    else if (selection)
      pane.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selection]);
  const notesByEnd = useMemo(() => {
    const byEnd = new Map<string, Draft[]>();
    for (const d of drafts) {
      const key = d.side + ':' + d.line;
      const entries = byEnd.get(key);
      if (entries) entries.push(d);
      else byEnd.set(key, [d]);
    }
    return byEnd;
  }, [drafts]);
  const { heading, lines } = useMemo(() => diffLines(text), [text]);
  const syntax = useMemo(() => highlightRows(lines, languageFor(path)), [lines, path]);
  return (
    <div
      ref={pane}
      className="diff-scroll"
      role="region"
      aria-label="File diff"
      tabIndex={0}
      onScroll={(e) => {
        const top = Math.round(e.currentTarget.scrollTop);
        if (top !== offset) onScroll(top);
      }}
    >
      <div className="diff-content">
        <div className="hunk-header">{heading}</div>
        {lines.map((line, i) => {
          const number = line.newLine ?? line.oldLine;
          const side = line.newLine === null ? 'old' : 'new';
          const comments =
            notesByEnd.get('old:' + line.oldLine) ?? notesByEnd.get('new:' + line.newLine) ?? [];
          const local = comments[0];
          const selectedLine = highlighted?.side === 'old' ? line.oldLine : line.newLine;
          return (
            <Fragment key={i}>
              <div
                data-old-line={line.oldLine ?? undefined}
                data-new-line={line.newLine ?? undefined}
                data-selected={
                  !!highlighted &&
                  selectedLine !== null &&
                  selectedLine >= (highlighted.startLine ?? highlighted.line) &&
                  selectedLine <= highlighted.line
                }
                className={'diff-line ' + line.kind}
              >
                <span className="comment-gutter">
                  {onComment && number !== null && (
                    <button
                      className={local ? 'has-draft' : ''}
                      aria-label={
                        local
                          ? 'Edit draft on ' + local.side + ' line ' + local.line
                          : 'Draft on ' + side + ' line ' + number
                      }
                      title="Click to comment, or drag across lines to comment on a block"
                      onPointerDown={(e) => drag.start(e, side, number)}
                      onPointerMove={drag.move}
                      onPointerUp={drag.end}
                      onLostPointerCapture={drag.cancel}
                      onPointerCancel={drag.cancel}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') drag.cancel();
                      }}
                      onClick={(e) => {
                        if (e.detail && drag.suppressClick.current) return;
                        onComment(local?.side ?? side, local?.line ?? number, line.text, local);
                      }}
                    >
                      <MessageSquarePlus size={13} />
                    </button>
                  )}
                </span>
                <span className="gutter">
                  {line.oldLine !== null && (
                    <button
                      aria-label={'Select old line ' + line.oldLine}
                      title="Shift-click to select a range"
                      onClick={(e) => {
                        if (line.oldLine !== null) onLine('old', line.oldLine, e.shiftKey);
                      }}
                    >
                      {line.oldLine}
                    </button>
                  )}
                </span>
                <span className="gutter">
                  {line.newLine !== null && (
                    <button
                      aria-label={'Select new line ' + line.newLine}
                      title="Shift-click to select a range"
                      onClick={(e) => {
                        if (line.newLine !== null) onLine('new', line.newLine, e.shiftKey);
                      }}
                    >
                      {line.newLine}
                    </button>
                  )}
                </span>
                <CodeLine text={line.text} tokens={syntax[i] ?? null} />
              </div>
              {published(line.oldLine, line.newLine)}
              {notes(line.oldLine, line.newLine, comments)}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
