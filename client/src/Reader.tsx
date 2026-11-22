import { LessonEditor, LessonList, useReviewLessons } from './ReviewLessons.js';
import { matchesLessonFile, matchesLessonLines } from '../../shared/lessons.js';
import type { DiscussionThread } from '../../shared/discussions.js';
import { useCommentDrag } from './useCommentDrag.js';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './components/Resizable.js';
import { PinnedQuestions, QuestionLinks, type QuestionPanel } from './PinnedQuestions.js';
import { RevisionChanges, revisionQueue } from './RevisionChanges.js';
import { InlineComments } from './InlineComments.js';
import { Activity, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { usePanelRef } from 'react-resizable-panels';
import { ChangedFiles } from './ChangedFiles.js';
import {
  type ReactNode,
  type RefObject,
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
import { ChatMarkdown } from './components/ChatMarkdown.js';
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
  PanelRightOpen,
  Sparkles,
  Pin,
  MessageSquarePlus,
  MessageSquare,
} from 'lucide-react';
import { FullFile, type FileFocus } from './FullFile.js';
import { usePrDiscussions, discussionsByLine } from './PrDiscussions.js';
import { ReviewChat } from './ReviewChat.js';
import { PipelineStatus } from './Pipelines.js';
import type { AgentCatalog, Anchor, SourceCitation } from '../../shared/assistant.js';

type Position = Pick<ReaderFile, 'hunk' | 'scroll' | 'reviewed'>;
function message(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : 'Could not load this review.';
}

// An action chosen on a PR's sidebar row, carried out once that PR is open.
export type PrCommand = { id: number; url: string; kind: 'summarise' | 'approve' };

export function Reader({
  fileToolSlot,
  url,
  onBack,
  agentPicker,
  agents,
  command,
  onPublished,
  accountEpoch,
}: {
  url: string;
  onBack: () => void;
  agentPicker: ReactNode;
  fileToolSlot: HTMLSpanElement | null;
  agents: AgentCatalog | null;
  command: PrCommand | null;
  onPublished: () => void;
  accountEpoch: string | null;
}) {
  const [fullFile, setFullFile] = useState(false);
  const [fullFocus, setFullFocus] = useState<(FileFocus & { path: string }) | null>(null);
  const [source, setSource] = useState<(SourceCitation & { run: string; visit: number }) | null>(
    null,
  );
  const sourceFocus = useMemo<FileFocus | null>(
    () => source && { side: 'new', line: source.line },
    [source],
  );
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
  const lessons = useReviewLessons(url, !!view);
  const [lessonThread, setLessonThread] = useState<DiscussionThread | null>(null);
  const discussions = usePrDiscussions(url, view?.revision, accountEpoch, (thread) => {
    if (!lessons.items) return null;
    const saved = lessons.items.some(
      (item) => item.sourceUrl === url && item.threadId === thread.id,
    );
    return (
      <button type="button" className="secondary" onClick={() => setLessonThread(thread)}>
        {saved ? 'Edit review lesson' : 'Remember review lesson'}
      </button>
    );
  });
  const earlierLessons = useMemo(
    () => (lessons.items ?? []).filter((item) => item.sourceUrl !== url),
    [lessons.items, url],
  );
  const codeLessons = useCallback(
    (lines: string[]) => {
      return (
        <LessonList
          title="Review lessons for these changes"
          items={earlierLessons.filter((item) => matchesLessonLines(item, lines))}
        />
      );
    },
    [earlierLessons],
  );
  const [line, setLine] = useState<(CommentAnchor & { revision: string }) | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [editor, setEditor] = useState<DraftEditor | null>(null);
  const filePanel = usePanelRef();
  const chatPanel = usePanelRef();
  const fileToolButton = useRef<HTMLButtonElement>(null);
  const expandChatButton = useRef<HTMLButtonElement>(null);
  const paneSwitch = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const hasView = !!view;
  useLayoutEffect(() => {
    const tabs = paneSwitch.current;
    if (!tabs) return;
    // The reader's container query exposes these controls when only one pane fits.
    const measure = () => setCompact(tabs.getClientRects().length > 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tabs);
    return () => observer.disconnect();
  }, [hasView]);
  const fileFilter = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [filesClosed, setFilesClosed] = useState(false);
  const [chatClosed, setChatClosed] = useState(false);
  const [section, setSection] = useState<'Overview' | 'Changes' | 'Discussion'>('Changes');
  const pendingFocus = useRef<RefObject<HTMLElement | null> | null>(null);
  function focusPanelControl() {
    const control = pendingFocus.current?.current;
    if (!control || !control.getClientRects().length || control.closest('[inert]')) return;
    control.focus();
    if (document.activeElement === control) pendingFocus.current = null;
  }
  function openChat() {
    pendingFocus.current = composer;
    chatPanel.current?.expand();
    setPaneName('chat');
    focusPanelControl();
  }
  const [paneName, setPaneName] = useState<'files' | 'diff' | 'chat'>('diff');
  useLayoutEffect(focusPanelControl, [filesClosed, chatClosed, paneName]);
  const filesVisible = compact ? paneName === 'files' : !filesClosed;
  function hideFiles() {
    pendingFocus.current = fileToolButton;
    setPaneName('diff');
    if (!compact) filePanel.current?.collapse();
    fileToolButton.current?.focus();
  }
  function showFiles() {
    pendingFocus.current = fileFilter;
    filePanel.current?.expand();
    setPaneName('files');
    focusPanelControl();
  }
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
  const since = !!view?.since && summaryRequest === null;
  const queue = useMemo(
    () => (since && view?.comparison ? revisionQueue(view, view.comparison) : null),
    [view, since],
  );
  function showComparison(enabled: boolean, path = view?.changePath ?? null) {
    if (!view?.comparison) return;
    setSource(null);
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
        setSection('Changes');
        setPaneName('diff');
        setSource(null);
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
  const nextUnread = [...files.slice(index + 1), ...files.slice(0, index)].find(
    (file) => !file.reviewed,
  );
  const visiblePane = paneName === 'chat' && (!selected || since) ? 'diff' : paneName;
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
    <div className="reader review-studio">
      {lessonThread && (
        <LessonEditor
          thread={lessonThread}
          url={url}
          saved={lessons.items?.find(
            (item) => item.sourceUrl === url && item.threadId === lessonThread.id,
          )}
          onSaved={lessons.setItems}
          onClose={() => setLessonThread(null)}
        />
      )}
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
              setSource(null);
              setFullFile(false);
              move(f, { hunk: hunk ?? f.hunk, scroll: 0 });
              showComparison(false);
              setPaneName('diff');
              setQuestionPanel(null);
            }
          }}
        />
      )}
      {view &&
        fileToolSlot &&
        createPortal(
          <button
            ref={fileToolButton}
            aria-expanded={filesVisible}
            aria-controls="review-files"
            aria-label={filesVisible ? 'Hide changed files' : 'Show changed files'}
            title={filesVisible ? 'Hide changed files' : 'Show changed files'}
            onClick={filesVisible ? hideFiles : showFiles}
          >
            <Files size={19} />
          </button>,
          fileToolSlot,
        )}
      {view && (
        <div ref={paneSwitch} className="pane-switch" aria-label="Review panes">
          {(['files', 'diff', 'chat'] as const)
            .filter((name) => !since || name !== 'chat')
            .map((name) => (
              <button
                key={name}
                disabled={name === 'chat' && !selected}
                aria-pressed={visiblePane === name}
                onClick={() => {
                  if (name === 'chat') chatPanel.current?.expand();
                  if (name === 'files') filePanel.current?.expand();
                  setPaneName(name);
                }}
              >
                {name === 'files' ? 'Files' : name === 'diff' ? 'Diff' : 'Chat'}
              </button>
            ))}
        </div>
      )}
      <ResizablePanelGroup
        id={since ? 'review-update-layout' : selected ? 'review-layout' : 'empty-review-layout'}
        className="reading-grid workbench"
        data-pane={visiblePane}
      >
        {view && (
          <>
            <ResizablePanel
              id="review-files"
              defaultSize="17%"
              minSize="165px"
              collapsible
              panelRef={filePanel}
              inert={!filesVisible}
              aria-hidden={!filesVisible || undefined}
              onResize={(size) => setFilesClosed(size.asPercentage === 0)}
            >
              <ChangedFiles
                files={queue?.files ?? view.files}
                changedSinceCheckpoint={queue ? view.comparison?.files.length : undefined}
                selected={queue ? queue.path : selected?.path}
                counts={commentCounts}
                filterRef={fileFilter}
                collapse={hideFiles}
                choose={(path) => {
                  if (queue) showComparison(true, path);
                  else {
                    const file = view.files.find((f) => f.path === path);
                    if (!file) return;
                    setSource(null);
                    move(file);
                  }
                  setSection('Changes');
                  setPaneName('diff');
                }}
              />
            </ResizablePanel>
            <ResizableHandle
              label={since ? 'Resize re-review queue and diff' : 'Resize files and diff'}
            />
          </>
        )}
        <ResizablePanel id="review-diff" minSize="300px">
          <main className="review-center">
            <header>
              <button
                aria-label="Back to workspace"
                title="Back to workspace"
                className="back"
                onClick={onBack}
              >
                <ArrowLeft size={15} />
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
              {chatClosed && !since && (
                <button
                  className="pane-toggle"
                  ref={expandChatButton}
                  aria-label="Expand review chat"
                  title="Expand review chat"
                  onClick={openChat}
                >
                  <PanelRightOpen size={16} />
                </button>
              )}
            </header>
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
                  selection={since || source ? null : selection}
                />
              )}
            </div>
            {view && (
              <>
                <div className="review-tabs" aria-label="Pull request views">
                  {(['Overview', 'Changes', 'Discussion'] as const).map((item) => (
                    <button
                      key={item}
                      aria-pressed={section === item}
                      onClick={() => setSection(item)}
                    >
                      {item}
                    </button>
                  ))}
                  <PipelineStatus
                    key={view.revision}
                    url={url}
                    head={view.meta.head}
                    revision={view.revision}
                  />
                </div>
                {section === 'Overview' && (
                  <section className="pr-detail" aria-labelledby="pr-description-heading">
                    <h2 id="pr-description-heading">PR description</h2>
                    {view.meta.description.trim() ? (
                      <ChatMarkdown text={view.meta.description} />
                    ) : (
                      <p>No description provided.</p>
                    )}
                    <LessonList
                      title="Repository review lessons"
                      items={lessons.items ?? []}
                      forget={async (lesson) =>
                        lessons.setItems(await window.reviewer.forgetReviewLesson(url, lesson))
                      }
                    />
                  </section>
                )}
                {section === 'Discussion' && (
                  <section className="pr-detail">{discussions.overview(view, inlineIds)}</section>
                )}
              </>
            )}
            {lessons.error && (
              <p role="alert">
                Could not load review lessons. {lessons.error}{' '}
                <button onClick={lessons.retry}>Retry lessons</button>
              </p>
            )}
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
                path={queue?.path}
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
            {view &&
              !since &&
              (source ? (
                <article>
                  <div className="file-heading">
                    <h2>
                      <FileCode2 size={16} />
                      {source.path}:{source.line}
                    </h2>
                    <p title={source.commit}>
                      {source.side === 'before' ? 'Original' : 'Reviewed head'} ·{' '}
                      <code>{source.commit.slice(0, 8)}</code>
                    </p>
                    <button onClick={() => setSource(null)}>Back to changes</button>
                  </div>
                  <FullFile
                    key={source.visit}
                    url={url}
                    path={source.path}
                    target={source}
                    focus={sourceFocus}
                  />
                </article>
              ) : selected ? (
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
                  </div>
                  {discussions.error && (
                    <div className="discussion-error" role="status">
                      {discussions.error}{' '}
                      <button disabled={discussions.posting} onClick={discussions.reload}>
                        Refresh threads
                      </button>
                    </div>
                  )}
                  <LessonList
                    title="Review lessons for this file"
                    items={earlierLessons.filter((item) => matchesLessonFile(item, selected))}
                  />
                  {showFullFile ? (
                    <FullFile
                      key={JSON.stringify([view.revision, selected.path])}
                      url={url}
                      target={view.revision}
                      path={selected.path}
                      discussions={renderThreads}
                      codeLessons={codeLessons}
                      focus={fullFocus?.path === selected.path ? fullFocus : null}
                    />
                  ) : (
                    <Patch
                      key={JSON.stringify([generation, view.revision, selected.path])}
                      url={url}
                      revision={view.revision}
                      file={selected}
                      ask={openChat}
                      codeLessons={codeLessons}
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
              ))}
          </main>
        </ResizablePanel>
        {view && selected && (
          <Activity mode={since ? 'hidden' : 'visible'}>
            <ResizableHandle label="Resize diff and chat" />
            <ResizablePanel
              id="review-chat"
              defaultSize="28%"
              minSize="235px"
              collapsible
              panelRef={chatPanel}
              inert={chatClosed}
              aria-hidden={chatClosed || undefined}
              onResize={(size) => setChatClosed(size.asPercentage === 0)}
            >
              <ReviewChat
                agents={agents}
                summaryRequest={summaryRequest}
                onSummaryStarted={() => {
                  if (view.since) showComparison(false);
                  setSummaryRequest(null);
                  chatPanel.current?.expand();
                }}
                url={url}
                view={view}
                file={selected}
                selection={selection}
                agentPicker={agentPicker}
                composerRef={composer}
                collapse={() => {
                  pendingFocus.current = expandChatButton;
                  chatPanel.current?.collapse();
                }}
                openSource={(run, cite) => {
                  if (since) showComparison(false);
                  setSection('Changes');
                  setPaneName('diff');
                  setSource((prev) => ({ ...cite, run, visit: (prev?.visit ?? 0) + 1 }));
                }}
                jump={(cite) => {
                  const target = files.find((f) => f.path === cite.path);
                  if (target) {
                    setSource(null);
                    if (since) showComparison(false);
                    setFullFile(false);
                    setSection('Changes');
                    setPaneName('diff');
                    move(target, { hunk: cite.hunk, scroll: 0 });
                    setLine({ ...cite, revision: view.revision });
                  }
                }}
              />
            </ResizablePanel>
          </Activity>
        )}
      </ResizablePanelGroup>
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
  codeLessons,
  ask,
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
  ask: () => void;
  codeLessons: (lines: string[]) => ReactNode;
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
  const hunk = hunks[file.hunk];
  const reminders = useMemo(
    () => hunk && codeLessons(hunk.split('\n').slice(1)),
    [hunk, codeLessons],
  );
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
  if (hunk === undefined) return <p role="status">Loading diff…</p>;
  return (
    <>
      {file.kind === 'partial' && <p role="status">GitHub supplied only part of this diff.</p>}
      <div className="hunk-nav">
        <span>
          Hunk {file.hunk + 1} of {hunks.length}
        </span>
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
      {reminders}
      <Hunk
        ask={ask}
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
  ask,
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
  ask: () => void;
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
                {selection &&
                  (selection.side === 'old' ? line.oldLine : line.newLine) === selection.line && (
                    <span className="line-tools">
                      <button
                        className="secondary"
                        disabled={!onComment}
                        aria-label={
                          selection.startLine && selection.startLine !== selection.line
                            ? 'Comment on lines ' + selection.startLine + '–' + selection.line
                            : 'Comment on line'
                        }
                        onClick={() => onComment?.(selection.side, selection.line, line.text)}
                      >
                        <MessageSquare size={13} /> Comment
                      </button>
                      <button className="secondary" onClick={ask}>
                        <Sparkles size={13} /> Ask assistant
                      </button>
                    </span>
                  )}
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
