import { LessonEditor, LessonList, useReviewLessons } from './ReviewLessons.js';
import { matchesLessonFile, matchesLessonLines } from '../../shared/lessons.js';
import type { DiscussionThread } from '../../shared/discussions.js';
import { useCommentDrag } from './useCommentDrag.js';
import { ReviewPanes } from './components/ReviewPanes.js';
import { defaultReviewLayout, type ReviewLayout } from './reviewLayouts.js';
import { ResizablePanel } from './components/Resizable.js';
import { PinnedQuestions, QuestionLinks, type QuestionPanel } from './PinnedQuestions.js';
import { RevisionChanges, revisionQueue } from './RevisionChanges.js';
import { InlineComments } from './InlineComments.js';
import { Activity, Fragment } from 'react';
import { useShortcuts } from './useShortcuts.js';
import { useRowWindow } from './useRowWindow.js';
import { hunkWindowThreshold, shouldWindow } from '../../shared/windowing.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import {
  adjacentFile,
  firstChangedLine,
  shortcutHelp,
  stepHunk,
  type ShortcutAction,
} from '../../shared/shortcuts.js';
import { DiffSearch } from './DiffSearch.js';
import {
  scanHunk,
  searchTimeSlice,
  literalPattern,
  type MatchSpan,
  type SearchHit,
} from '../../shared/diff-search.js';
import { usePanelRef } from 'react-resizable-panels';
import { ChangedFiles } from './ChangedFiles.js';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReaderFile, ReaderView } from '../../shared/reader.js';
import { shortRevision, splitHunks, uncommittedDigest } from '../../shared/reader.js';
import { isLocalReview, type LocalReviewInfo } from '../../shared/reviews.js';
import {
  fileDiff,
  fileDiffPage,
  filePageRows,
  filePageScroll,
  type FileDiff,
} from '../../shared/file-diff.js';
import { highlightRows, languageFor } from '../../shared/highlight.js';
import { ChatMarkdown } from './components/ChatMarkdown.js';
import { CommitLink, DraftLabel, PrNumberLink, formatPrDate } from './components/PrMetadata.js';
import { CodeLine } from './components/CodeLine.js';
import './reader.css';
import { DraftReview, type DraftEditor } from './DraftReview.js';
import type { Bundle, Draft, CommentAnchor } from '../../shared/publish.js';
import {
  Search,
  GitBranch,
  CalendarDays,
  GitCommitHorizontal,
  UserRound,
  RotateCw,
  FileCode2,
  PanelLeftOpen,
  PanelLeftClose,
  Sparkles,
  Pin,
  MessageSquarePlus,
  MessageSquare,
  FolderGit2,
  Keyboard,
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
export type PrCommand = { id: number; url: string; kind: 'summarise' | 'review' | 'approve' };

export function Reader({
  layout,
  url,
  onBack,
  agentPicker,
  agents,
  command,
  onPublished,
  onSnapshotSaved,
  accountEpoch,
  local: localInfo,
  singleKeyShortcuts,
}: {
  layout: ReviewLayout;
  url: string;
  // Present for a local branch review, which has no GitHub discussion, checks or publishing.
  local: LocalReviewInfo | null;
  onBack: () => void;
  agentPicker: ReactNode;
  agents: AgentCatalog | null;
  command: PrCommand | null;
  onPublished: () => void;
  onSnapshotSaved: () => void;
  accountEpoch: string | null;
  // The Single-key shortcuts setting.
  singleKeyShortcuts: boolean;
}) {
  const [jump, setJump] = useState<{ path: string; hunk: number } | null>(null);
  const [source, setSource] = useState<(SourceCitation & { run: string; visit: number }) | null>(
    null,
  );
  const sourceFocus = useMemo<FileFocus | null>(
    () => source && { side: 'new', line: source.line },
    [source],
  );
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
  const local = isLocalReview(url);
  const lessons = useReviewLessons(url, !!view && !local);
  const [lessonThread, setLessonThread] = useState<DiscussionThread | null>(null);
  const discussions = usePrDiscussions(
    url,
    local ? undefined : view?.revision,
    accountEpoch,
    (thread) => {
      if (!lessons.items) return null;
      const saved = lessons.items.some(
        (item) => item.sourceUrl === url && item.threadId === thread.id,
      );
      return (
        <button type="button" className="secondary" onClick={() => setLessonThread(thread)}>
          {saved ? 'Edit review lesson' : 'Remember review lesson'}
        </button>
      );
    },
  );
  const earlierLessons = useMemo(
    () => (lessons.items ?? []).filter((item) => item.sourceUrl !== url),
    [lessons.items, url],
  );
  const codeLessons = useCallback(
    (hunk: string) => {
      if (!earlierLessons.length) return null;
      const lines = hunk.split('\n').slice(1);
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
  const fileToolButton = useRef<HTMLButtonElement>(null);
  const fileFilter = useRef<HTMLInputElement>(null);
  const readerElement = useRef<HTMLDivElement>(null);
  const [filesClosed, setFilesClosed] = useState(false);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const reader = readerElement.current;
    if (!reader) return;
    // Match the single-pane container query, including when the repository sidebar is resized.
    const measure = () => setCompact(reader.getBoundingClientRect().width <= 680);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(reader);
    return () => observer.disconnect();
  }, []);
  const expandChatButton = useRef<HTMLButtonElement>(null);
  const closeChatButton = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const hasView = !!view;
  const [section, setSection] = useState<'Overview' | 'Changes' | 'Discussion'>('Changes');
  const pendingFocus = useRef<RefObject<HTMLElement | null> | null>(null);
  function focusPanelControl() {
    const target = pendingFocus.current;
    const control =
      target === composer && (!composer.current || composer.current.disabled)
        ? closeChatButton.current
        : target?.current;
    if (!control || !control.getClientRects().length || control.closest('[inert]')) return;
    control.focus();
    if (document.activeElement === control) pendingFocus.current = null;
  }
  function openChat() {
    pendingFocus.current = composer;
    setChatOpen(true);
    setPaneName('chat');
    focusPanelControl();
  }
  const [paneName, setPaneName] = useState<'files' | 'diff' | 'chat'>('diff');
  const filesVisible = compact ? paneName === 'files' : !filesClosed;
  useLayoutEffect(focusPanelControl, [chatOpen, filesVisible, paneName]);
  function toggleFiles() {
    if (filesVisible) {
      pendingFocus.current = fileToolButton;
      if (!compact) filePanel.current?.collapse();
      setPaneName('diff');
    } else {
      pendingFocus.current = fileFilter;
      if (compact) setPaneName('files');
      else filePanel.current?.expand();
    }
  }
  // Each sidebar command becomes a one-shot request for the pane that carries it out.
  const [seenCommand, setSeenCommand] = useState<number | null>(null);
  const [prRequest, setPrRequest] = useState<{ id: number; kind: 'review' | 'summary' } | null>(
    null,
  );
  const [approveRequest, setApproveRequest] = useState<number | null>(null);
  if (command && command.id !== seenCommand) {
    setSeenCommand(command.id);
    if (command.kind !== 'approve') {
      setChatOpen(true);
      setPrRequest({ id: command.id, kind: command.kind === 'review' ? 'review' : 'summary' });
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
  const since = !!view?.since && prRequest === null;
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHit, setSearchHit] = useState<
    (SearchHit & { revision: string; generation: number }) | null
  >(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchRegion = useRef<HTMLDivElement>(null);
  function closeSearch() {
    setSearchOpen(false);
    setSearchHit(null);
    searchButton.current?.focus();
  }
  useLayoutEffect(() => {
    if (paneName === 'diff' && searchOpen) searchRegion.current?.querySelector('input')?.focus();
  }, [paneName, searchOpen]);
  useEffect(() => {
    if (!hasView) return;
    function find(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== 'f' ||
        document.querySelector('[role="dialog"], dialog[open]')
      )
        return;
      const input = searchRegion.current?.querySelector('input');
      if (
        event.target instanceof HTMLElement &&
        event.target !== input &&
        event.target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      event.preventDefault();
      setPaneName('diff');
      setSearchOpen(true);
      input?.focus();
      input?.select();
    }
    window.addEventListener('keydown', find);
    return () => window.removeEventListener('keydown', find);
  }, [hasView]);
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
        if (!local) onSnapshotSaved();
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
  }, [url, attempt, local, onSnapshotSaved]);

  useEffect(() => {
    if (loading || transition || !hasView) return;
    let live = true,
      checking = false,
      queued = false,
      nextCheck = 0,
      delay = 60000;
    async function check(force = false) {
      if (!live || document.hidden || (!local && !document.hasFocus())) return;
      if (checking) {
        if (force) queued = true;
        return;
      }
      if (!force && Date.now() < nextCheck) return;
      checking = true;
      try {
        const { incoming, isDraft, statusChanged } = await window.reviewer.checkUpdate(url);
        if (live && statusChanged) onSnapshotSaved();
        if (live)
          setView((v) => {
            if (!v || (v.incoming === incoming && v.meta.isDraft === isDraft)) return v;
            return { ...v, incoming, meta: { ...v.meta, isDraft } };
          });
        delay = 60000;
      } catch {
        delay = Math.min(delay * 2, 15 * 60000);
      } finally {
        nextCheck = Date.now() + delay;
        checking = false;
        if (queued && live) {
          queued = false;
          void check(true);
        }
      }
    }
    const trigger = () => void check(local);
    const unsubscribe = local
      ? window.reviewer.onLocalFilesChanged((changedUrl) => {
          if (changedUrl === url) void check(true);
        })
      : undefined;
    // Catch changes during initial load, a revision transition, or while the window was hidden.
    if (local) trigger();
    window.addEventListener('focus', trigger);
    document.addEventListener('visibilitychange', trigger);
    const timer = window.setInterval(() => void check(), 60000);
    return () => {
      live = false;
      unsubscribe?.();
      window.removeEventListener('focus', trigger);
      document.removeEventListener('visibilitychange', trigger);
      window.clearInterval(timer);
    };
  }, [url, local, loading, transition, hasView, onSnapshotSaved]);

  const [refreshHint, setRefreshHint] = useState<{ path: string; revision: string } | null>(null);
  useEffect(() => {
    if (!refreshHint) return;
    const timer = window.setTimeout(() => setRefreshHint(null), 4000);
    return () => window.clearTimeout(timer);
  }, [refreshHint]);
  async function changeRevision(action: 'update' | 'checkpoint' | 'retry-file' | 'auto-refresh') {
    if (!view || transition) return;
    setTransition(true);
    try {
      let next: ReaderView;
      if (action === 'retry-file' || action === 'auto-refresh') {
        if (!view.selected || editor || (action === 'auto-refresh' && !view.incoming)) return;
        next = await window.reviewer.refreshLocalFile(
          { url, revision: view.revision, path: view.selected },
          action === 'auto-refresh' ? (view.incoming ?? undefined) : undefined,
        );
        if (action === 'auto-refresh' && next.selected && next.revision !== view.revision)
          setRefreshHint({ path: next.selected, revision: next.revision });
        setGeneration((n) => n + 1);
      } else if (action === 'update') {
        if (!view.incoming) return;
        next = await window.reviewer.openUpdate(url, view.incoming);
      } else next = await window.reviewer.finishRevision(url, view.revision);
      setView(next);

      if (action !== 'checkpoint') {
        if (!local) onSnapshotSaved();
        if (action !== 'auto-refresh') {
          setSection('Changes');
          setPaneName('diff');
        }
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
  const selectedPath = view?.selected;
  const revision = view?.revision;
  const incoming = view?.incoming;
  const canAutoRefresh =
    local && !loading && !transition && !editor && !since && !source && section === 'Changes';
  const attemptedRefresh = useRef('');
  const applyIncoming = useEffectEvent(() => {
    const key = JSON.stringify([revision, selectedPath, incoming]);
    if (attemptedRefresh.current === key) return;
    attemptedRefresh.current = key;
    void changeRevision('auto-refresh');
  });
  useEffect(() => {
    if (!incoming) attemptedRefresh.current = '';
    if (!canAutoRefresh || !incoming || !selectedPath) return;
    let timer: number | undefined;
    function applyWhenReady() {
      // A modal can contain an unsaved review summary or a draft being relocated.
      if (document.querySelector('[role="dialog"], dialog[open]')) {
        timer = window.setTimeout(applyWhenReady, 400);
        return;
      }
      applyIncoming();
    }
    applyWhenReady();
    return () => window.clearTimeout(timer);
  }, [canAutoRefresh, incoming, revision, selectedPath]);

  const move = useCallback(
    (file: ReaderFile, change: Partial<Position> = {}) => {
      if (!view) return;
      if (change.hunk !== undefined && change.scroll === 0)
        setJump({ path: file.path, hunk: change.hunk });
      else if (change.scroll !== undefined || file.path !== view.selected) setJump(null);
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
  if (prRequest && !selected && !loading) {
    setPrRequest(null);
    setSaveError(
      view
        ? 'There are no changed files to review on this revision.'
        : 'Load the pull request before starting a review.',
    );
  }
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
  // Keyboard shortcuts drive the same handlers as the on-screen controls.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const hunkControl = useRef<HunkControl | null>(null);
  const hunkFocus = useRef<{ path: string; hunk: number; until: number } | null>(null);
  const hunkCounts = useRef(new Map<string, number>());
  const navigation = useRef(0);
  useEffect(
    () => () => {
      // A hunk lookup that finishes after the revision changed or the review closed is stale.
      navigation.current += 1;
    },
    [view?.revision],
  );
  const claimHunkFocus = useCallback((path: string, hunk: number) => {
    const wanted = hunkFocus.current;
    if (!wanted || wanted.path !== path || wanted.hunk !== hunk) return false;
    hunkFocus.current = null;
    return wanted.until > Date.now();
  }, []);
  async function countHunks(file: ReaderFile) {
    if (!view || (file.kind !== 'text' && file.kind !== 'partial')) return 0;
    const key = view.revision + '\0' + file.path;
    const known = hunkCounts.current.get(key);
    if (known !== undefined) return known;
    const count = splitHunks(
      await window.reviewer.filePatch({ url, revision: view.revision, path: file.path }),
    ).length;
    hunkCounts.current.set(key, count);
    return count;
  }
  function goTo(file: ReaderFile, hunk: number, hunkCount: number | null) {
    const hasHunks = file.kind === 'text' || file.kind === 'partial';
    hunkFocus.current = hasHunks ? { path: file.path, hunk, until: Date.now() + 5000 } : null;
    move(file, file.hunk === hunk ? {} : { hunk, scroll: 0 });
    setAnnouncement(
      file.path +
        ', file ' +
        (files.indexOf(file) + 1) +
        ' of ' +
        files.length +
        (hunkCount ? ', hunk ' + (hunk + 1) + ' of ' + hunkCount : ''),
    );
  }
  async function stepBy(direction: 1 | -1) {
    if (!view || !selected) return;
    const token = ++navigation.current;
    try {
      const target = await stepHunk(
        files.length,
        { index, hunk: selected.hunk },
        direction,
        (i) => {
          const file = files[i];
          return file ? countHunks(file) : 0;
        },
      );
      if (token !== navigation.current) return;
      const file = target && files[target.index];
      if (!target || !file) {
        setAnnouncement(direction === 1 ? 'This is the last hunk.' : 'This is the first hunk.');
        return;
      }
      goTo(file, target.hunk, await countHunks(file));
    } catch (cause) {
      if (token === navigation.current) setSaveError(message(cause));
    }
  }
  function stepFile(direction: 1 | -1) {
    const target = adjacentFile(files.length, index, direction);
    const file = target === null ? undefined : files[target];
    if (file) goTo(file, file.hunk, null);
    else setAnnouncement(direction === 1 ? 'This is the last file.' : 'This is the first file.');
  }
  function runShortcut(action: ShortcutAction) {
    if (action === 'show-help') {
      setShortcutsOpen(true);
      return;
    }
    if (!view || !selected || section !== 'Changes' || since || source) return;
    switch (action) {
      case 'next-hunk':
        void stepBy(1);
        return;
      case 'previous-hunk':
        void stepBy(-1);
        return;
      case 'next-file':
        stepFile(1);
        return;
      case 'previous-file':
        stepFile(-1);
        return;
      case 'next-unread':
        if (nextUnread) goTo(nextUnread, nextUnread.hunk, null);
        else setAnnouncement('There are no other unread files.');
        return;
      case 'toggle-reviewed':
        move(selected, { reviewed: !selected.reviewed });
        setAnnouncement(
          selected.path + (selected.reviewed ? ' marked unread' : ' marked reviewed'),
        );
        return;
      case 'comment':
        // Keep text already typed in an open editor rather than replacing it.
        if (editor) document.getElementById('inline-comment-body')?.focus();
        else hunkControl.current?.comment();
        return;
      case 'ask':
        if (selection) openChat();
        else setAnnouncement('Select a line to ask the assistant about it.');
        return;
      default: {
        const unreachable: never = action;
        return unreachable;
      }
    }
  }
  useShortcuts(singleKeyShortcuts && hasView, runShortcut);
  const chatFile = queue ? files.find((file) => file.path === queue.path) : selected;
  const fileTree = view && (
    <ChangedFiles
      collapse={toggleFiles}
      filterRef={fileFilter}
      files={queue?.files ?? files}
      selected={queue ? queue.path : selected?.path}
      counts={commentCounts}
      changedSinceCheckpoint={queue ? view.comparison?.files.length : undefined}
      choose={(path) => {
        if (queue) showComparison(true, path);
        else {
          const file = files.find((f) => f.path === path);
          if (!file) return;
          setSource(null);
          move(file);
        }
        if (compact) pendingFocus.current = fileToolButton;
        setSection('Changes');
        setPaneName('diff');
      }}
    />
  );
  function selectLine(anchor: Anchor, extend: boolean) {
    if (!view) return;
    if (selected && selected.hunk !== anchor.hunk) move(selected, { hunk: anchor.hunk });
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
  const filePane = view && (
    <ResizablePanel
      id="review-files"
      defaultSize="20%"
      minSize="165px"
      collapsible
      panelRef={filePanel}
      onResize={(size) => setFilesClosed(size.asPercentage === 0)}
      inert={!filesVisible}
      aria-hidden={!filesVisible || undefined}
    >
      {fileTree}
    </ResizablePanel>
  );
  const chatPane = (!local || view) && (
    <Activity mode={chatOpen ? 'visible' : 'hidden'}>
      <ResizablePanel id="review-chat" defaultSize="28%" minSize="235px">
        <ReviewChat
          agents={agents}
          prRequest={prRequest}
          bundle={bundle}
          onDrafts={(next) =>
            setBundle((prev) => (prev && prev.version > next.version ? prev : next))
          }
          onPrStarted={() => {
            if (view?.since) showComparison(false);
            setPrRequest(null);
            setChatOpen(true);
          }}
          url={url}
          local={local}
          view={view}
          file={chatFile}
          comparison={since}
          loading={loading}
          selection={since ? null : selection}
          agentPicker={agentPicker}
          composerRef={composer}
          closeButtonRef={closeChatButton}
          collapse={() => {
            pendingFocus.current = expandChatButton;
            setChatOpen(false);
            setPaneName('diff');
          }}
          openSource={(run, cite) => {
            if (since) showComparison(false);
            setSection('Changes');
            setPaneName('diff');
            setSource((prev) => ({ ...cite, run, visit: (prev?.visit ?? 0) + 1 }));
          }}
          jump={(cite) => {
            const target = files.find((f) => f.path === cite.path);
            if (target && view) {
              setSource(null);
              if (since) showComparison(false);
              setSection('Changes');
              setPaneName('diff');
              move(target, { hunk: cite.hunk, scroll: 0 });
              setLine({ ...cite, revision: view.revision });
            }
          }}
        />
      </ResizablePanel>
    </Activity>
  );
  return (
    <div className="reader review-studio" ref={readerElement}>
      <div role="status" aria-live="polite" className="visually-hidden">
        {announcement}
      </div>
      {shortcutsOpen && (
        <WorkspaceDialog
          title="Keyboard shortcuts"
          icon={<Keyboard size={20} />}
          onClose={() => setShortcutsOpen(false)}
        >
          <table className="shortcut-list">
            <caption className="visually-hidden">Reader shortcuts</caption>
            <thead>
              <tr>
                <th scope="col">Keys</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {shortcutHelp.map((entry) => (
                <tr key={entry.keys.join(' ')}>
                  <th scope="row">
                    {entry.keys.map((key, i) => (
                      <Fragment key={key}>
                        {i > 0 && ' or '}
                        <kbd>{key}</kbd>
                      </Fragment>
                    ))}
                  </th>
                  <td>{entry.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Shortcuts apply while reading changes, and not while you type or a dialog is open.
            {singleKeyShortcuts
              ? ' Turn single-key shortcuts off in Settings.'
              : ' Single-key shortcuts are off. Turn them on in Settings.'}
          </p>
        </WorkspaceDialog>
      )}
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
              move(f, { hunk: hunk ?? f.hunk, scroll: 0 });
              showComparison(false);
              setPaneName('diff');
              setQuestionPanel(null);
            }
          }}
        />
      )}
      <ReviewPanes
        layout={compact ? defaultReviewLayout : layout}
        pane={paneName}
        files={filePane}
        chat={chatPane}
        chatOpen={chatOpen}
      >
        <ResizablePanel id="review-diff" minSize="265px">
          <main className="review-center">
            <header>
              {view && (
                <button
                  className="pane-toggle"
                  ref={fileToolButton}
                  aria-expanded={filesVisible}
                  aria-controls="review-files"
                  aria-label={filesVisible ? 'Hide changed files' : 'Show changed files'}
                  title={filesVisible ? 'Hide changed files' : 'Show changed files'}
                  onClick={toggleFiles}
                >
                  {filesVisible ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                </button>
              )}
              <button className="queue-breadcrumb" onClick={onBack}>
                {local ? 'Local reviews' : 'Pull requests'}
              </button>
              <span aria-hidden>/</span>
              {local ? (
                <span className="repo" title={localInfo?.path}>
                  <FolderGit2 size={15} />
                  <span className="review-tag">Local</span>
                  {localInfo?.repository ?? 'Local branch'}
                </span>
              ) : (
                <span
                  className="repo"
                  title={new URL(url).pathname.split('/').slice(1, 3).join('/')}
                >
                  <PrNumberLink url={url} onError={setSaveError} />
                </span>
              )}
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
              <button
                className="secondary"
                aria-haspopup="dialog"
                title="Keyboard shortcuts (?)"
                onClick={() => setShortcutsOpen(true)}
              >
                <Keyboard size={14} /> Keyboard shortcuts
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
            </header>
            <div className="pr-heading">
              <div className="overview">
                <h1>{view?.meta.title ?? (local ? 'Local branch' : 'Pull request')}</h1>
                {view && (
                  <div className="pr-meta">
                    {!local && view.meta.isDraft && <DraftLabel />}
                    <span>
                      <UserRound size={13} />
                      {view.meta.author}
                    </span>
                    {!local && view.meta.openedAt && (
                      <span>
                        <CalendarDays size={13} />
                        <time dateTime={view.meta.openedAt}>
                          Opened {formatPrDate(view.meta.openedAt)}
                        </time>
                      </span>
                    )}
                    <span>
                      <GitBranch size={13} />
                      <code>
                        {view.meta.headBranch} → {view.meta.baseBranch}
                      </code>
                    </span>
                    <span title={view.meta.head}>
                      <GitCommitHorizontal size={14} />
                      {local ? (
                        <code>{shortRevision(view.revision)}</code>
                      ) : (
                        <CommitLink url={url} head={view.meta.head} onError={setSaveError} />
                      )}
                    </span>
                    {local && uncommittedDigest(view.revision) && (
                      <span
                        className="review-tag"
                        title="Includes staged, unstaged and untracked files"
                      >
                        Uncommitted changes
                      </span>
                    )}
                  </div>
                )}
              </div>
              {(view || !local) && (
                <button
                  className="ask-review"
                  ref={expandChatButton}
                  onClick={openChat}
                  aria-expanded={chatOpen}
                >
                  <MessageSquare size={16} /> {local ? 'Ask about branch' : 'Ask about PR'}
                </button>
              )}
              {view && bundle && (
                <DraftReview
                  url={url}
                  local={local}
                  onCheckpoint={async () => {
                    setView(await window.reviewer.finishRevision(url, view.revision));
                  }}
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
                <div
                  className="review-tabs"
                  aria-label={local ? 'Local review views' : 'Pull request views'}
                >
                  {(local
                    ? (['Overview', 'Changes'] as const)
                    : (['Overview', 'Changes', 'Discussion'] as const)
                  ).map((item) => (
                    <button
                      key={item}
                      aria-pressed={section === item}
                      onClick={() => setSection(item)}
                    >
                      {item}
                    </button>
                  ))}
                  {!local && (
                    <PipelineStatus
                      key={view.revision}
                      url={url}
                      head={view.meta.head}
                      revision={view.revision}
                    />
                  )}
                  <button
                    ref={searchButton}
                    aria-expanded={searchOpen}
                    title="Search changed lines (Ctrl+F or ⌘F)"
                    onClick={() => {
                      if (searchOpen) closeSearch();
                      else setSearchOpen(true);
                    }}
                  >
                    <Search size={14} /> Search diff
                  </button>
                </div>
                {searchOpen && (
                  <div ref={searchRegion}>
                    <DiffSearch
                      key={local ? url : view.revision}
                      url={url}
                      view={view}
                      generation={generation}
                      close={closeSearch}
                      jump={(hit) => {
                        setSearchHit(hit && { ...hit, revision: view.revision, generation });
                        if (!hit) return;
                        const file = files.find((entry) => entry.path === hit.path);
                        if (!file) return;
                        setPaneName('diff');
                        setSection('Changes');
                        setSource(null);
                        if (since) showComparison(false);
                        if (selected?.path !== hit.path || selected.hunk !== hit.hunk)
                          move(file, { hunk: hit.hunk, scroll: 0 });
                      }}
                    />
                  </div>
                )}
                {section === 'Overview' && (
                  <section className="pr-detail" aria-labelledby="pr-description-heading">
                    <h2 id="pr-description-heading">
                      {local ? 'Branch description' : 'PR description'}
                    </h2>
                    {view.meta.description.trim() ? (
                      <ChatMarkdown text={view.meta.description} />
                    ) : (
                      <p>No description provided.</p>
                    )}
                    {!local && (
                      <LessonList
                        title="Repository review lessons"
                        items={lessons.items ?? []}
                        forget={async (lesson) =>
                          lessons.setItems(await window.reviewer.forgetReviewLesson(url, lesson))
                        }
                      />
                    )}
                  </section>
                )}
                {section === 'Discussion' && !local && (
                  <section className="pr-detail">
                    {discussions.overview(
                      since ? queue?.path : source ? undefined : selected?.path,
                    )}
                  </section>
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
                {local
                  ? view
                    ? 'Checking the local repository for changes…'
                    : 'Reading the local repository…'
                  : view
                    ? 'Checking GitHub for updates…'
                    : 'Fetching pull request from GitHub…'}
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
                Showing {files.length} of {view.meta.totalFiles} changed files.{' '}
                {local
                  ? 'The local review shows up to 3,000 files.'
                  : 'GitHub returned a partial file list.'}
              </p>
            )}
            {view?.incoming && (
              <div className="revision-toolbar" role="status">
                <strong>{local ? 'Local changes available' : 'PR update available'}</strong>
                <code>{shortRevision(view.incoming)}</code>
                <button
                  disabled={transition || loading || !!editor}
                  title={editor ? 'Save or close your inline draft first' : undefined}
                  onClick={() => void changeRevision('update')}
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
                  onClick={() => void changeRevision('checkpoint')}
                >
                  Save review checkpoint
                </button>
              </div>
            )}
            {view && !local && discussions.loading && !discussions.data && (
              <p role="status">Loading review comments…</p>
            )}
            {discussions.error && (
              <div className="discussion-error" role="status">
                {discussions.error}{' '}
                <button disabled={discussions.posting} onClick={discussions.reload}>
                  Refresh threads
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
                fileConversations={discussions.fileConversations(queue?.path)}
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
                <article>
                  <div className="file-heading">
                    <h2>
                      <FileCode2 size={16} />
                      {selected.path}
                    </h2>
                    <small>
                      {index + 1} of {files.length} files
                    </small>
                    {refreshHint?.revision === view.revision &&
                      refreshHint.path === selected.path && (
                        <small className="diff-refresh-hint" role="status">
                          <RotateCw size={12} aria-hidden /> Diff refreshed
                        </small>
                      )}
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
                  <LessonList
                    title="Review lessons for this file"
                    items={earlierLessons.filter((item) => matchesLessonFile(item, selected))}
                  />
                  <Patch
                    key={JSON.stringify([generation, view.revision, selected.path])}
                    searchHit={
                      searchOpen &&
                      searchHit?.revision === view.revision &&
                      searchHit.generation === generation &&
                      searchHit.path === selected.path &&
                      searchHit.hunk === selected.hunk
                        ? searchHit
                        : null
                    }
                    jump={jump}
                    url={url}
                    revision={view.revision}
                    file={selected}
                    retryLocal={local ? () => void changeRevision('retry-file') : undefined}
                    retryDisabled={transition || loading || !!editor}
                    retryingRevision={transition}
                    ask={openChat}
                    controlRef={hunkControl}
                    claimFocus={claimHunkFocus}
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
                        (d) => d.revision === view.revision && d.path === selected.path,
                      ) ?? []
                    }
                    compose={
                      bundle && !bundle.pending && !transition
                        ? (anchor, excerpt, draft) => {
                            if (selected.hunk !== anchor.hunk)
                              move(selected, { hunk: anchor.hunk });
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
                    publishedLines={threadsByLine}
                    editorAnchor={
                      editor && editor.location.path === selected.path ? editor.location : null
                    }
                    onLine={selectLine}
                    notes={(oldLine, newLine, comments, hunk, index) => {
                      if (!editor && !comments.length) return null;
                      if (!bundle) return null;
                      const matches = (a: CommentAnchor) =>
                        a.path === selected.path &&
                        a.hunk === index &&
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
                          hunk={hunk}
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
                    fileConversations={discussions.fileConversations(selected.path, inlineIds)}
                    published={renderThreads}
                    move={move}
                  />
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
      </ReviewPanes>
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
type Notes = (
  oldLine: number | null,
  newLine: number | null,
  comments: Draft[],
  hunk: string,
  index: number,
) => ReactNode;
type Compose = ((anchor: CommentAnchor, excerpt: string, draft?: Draft) => void) | undefined;
type Move = (file: ReaderFile, change: Partial<Position>) => void;
// Lines that carry something beneath them, which a windowed hunk keeps rendered.
type PublishedLines = ReadonlyMap<string, unknown>;
type EditorAnchor = Pick<CommentAnchor, 'side' | 'line'> | null;
function Patch({
  searchHit,
  jump,
  codeLessons,
  ask,
  controlRef,
  claimFocus,
  pinnedLinks,
  retryLocal,
  retryDisabled,
  retryingRevision,
  url,
  revision,
  file,
  drafts,
  compose,
  notes,
  published,
  publishedLines,
  fileConversations,
  editorAnchor,
  selection,
  onLine,
  move,
}: {
  searchHit: SearchHit | null;
  jump: { path: string; hunk: number } | null;
  url: string;
  revision: string;
  file: ReaderFile;
  ask: () => void;
  controlRef: RefObject<HunkControl | null>;
  claimFocus: (path: string, hunk: number) => boolean;
  codeLessons: (hunk: string) => ReactNode;
  pinnedLinks: ReactNode;
  retryLocal: (() => void) | undefined;
  retryDisabled: boolean;
  retryingRevision: boolean;
  drafts: Draft[];
  compose: Compose;
  notes: Notes;
  published: Published;
  publishedLines: PublishedLines;
  fileConversations: ReactNode;
  editorAnchor: EditorAnchor;
  move: Move;
  selection: CommentAnchor | null;
  onLine: (a: Anchor, extend: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<{
    full: string | null;
    saved: string;
    error: string;
    attempt: number;
  } | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (file.kind === 'binary') return;
    let live = true;
    const key = { url, revision, path: file.path };
    async function load() {
      const hasPatch = file.kind === 'text' || file.kind === 'partial';
      const completePatch =
        file.kind === 'text' && (file.status === 'added' || file.status === 'removed');
      const [saved, full] = await Promise.allSettled([
        hasPatch ? window.reviewer.filePatch(key) : Promise.resolve(''),
        completePatch ? Promise.resolve(null) : window.reviewer.fullFile(key),
      ]);
      if (!live) return;
      const patch = saved.status === 'fulfilled' ? saved.value : '';
      setLoaded({
        attempt,
        full: full.status === 'fulfilled' ? full.value : null,
        saved: patch,
        error:
          full.status === 'rejected'
            ? message(full.reason)
            : saved.status === 'rejected'
              ? message(saved.reason)
              : '',
      });
    }
    void load();
    return () => {
      live = false;
    };
  }, [url, revision, file.path, file.kind, file.status, attempt]);
  const diff = useMemo(() => loaded && fileDiff(loaded.full, loaded.saved), [loaded]);
  const hunk = diff?.savedHunks[file.hunk];
  const [found, setFound] = useState<{ hit: SearchHit; span: MatchSpan } | null>(null);
  const match = found && found.hit === searchHit ? found.span : null;
  useEffect(() => {
    if (!searchHit || !hunk || !diff) return;
    const controller = new AbortController();
    const pause = searchTimeSlice(
      () => new Promise((resolve) => window.setTimeout(resolve, 0)),
      controller.signal,
    );
    scanHunk(hunk, literalPattern(searchHit.query), searchHit.filter, pause, searchHit.occurrence)
      .then(({ match }) => {
        const row = match ? diff.displayPosition(searchHit.hunk, match.row) : undefined;
        if (!controller.signal.aborted && match && row !== undefined && row >= 0)
          setFound({ hit: searchHit, span: { ...match, row } });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          console.error('Could not locate the diff search match.', message(cause));
      });
    return () => controller.abort();
  }, [searchHit, hunk, diff]);
  const [page, setPage] = useState(Math.floor(file.scroll / filePageScroll));
  const [previous, setPrevious] = useState({ diff, jump, selection, match });
  if (
    diff !== previous.diff ||
    jump !== previous.jump ||
    selection !== previous.selection ||
    match !== previous.match
  ) {
    setPrevious({ diff, jump, selection, match });
    if (diff && diff.length > filePageRows) {
      let row: number | undefined;
      if (match && previous.match !== match) row = match.row;
      else if (selection && (selection !== previous.selection || !previous.diff))
        row = diff.find(selection.side, selection.startLine ?? selection.line);
      else if (jump?.path === file.path && (jump !== previous.jump || !previous.diff))
        row = diff.displayPosition(jump.hunk);
      else if (!previous.diff && !file.scroll && file.hunk) row = diff.displayPosition(file.hunk);
      if (row !== undefined) setPage(Math.floor(row / filePageRows));
    }
  }
  const pageCount = Math.max(1, Math.ceil((diff?.length ?? 0) / filePageRows));
  const currentPage = Math.min(page, pageCount - 1);
  const section = useMemo(() => diff && fileDiffPage(diff, currentPage), [diff, currentPage]);
  const offsetBase = currentPage * filePageScroll;
  useLayoutEffect(() => {
    // A jump to the top of a new page does not fire a native scroll event.
    if (diff && Math.floor(file.scroll / filePageScroll) !== currentPage)
      move(file, { scroll: offsetBase });
  }, [currentPage, diff, file, move, offsetBase]);
  const localMatch = useMemo(() => {
    if (!match || Math.floor(match.row / filePageRows) !== currentPage) return null;
    return { ...match, row: match.row - currentPage * filePageRows };
  }, [match, currentPage]);
  function choosePage(next: number) {
    setPage(next);
    move(file, { scroll: next * filePageScroll });
  }
  const reminders = useMemo(() => hunk && codeLessons(hunk), [hunk, codeLessons]);
  if (file.kind === 'binary')
    return (
      <div className="diff-scroll">
        <p className="patch-note">Binary file. A line diff is unavailable.</p>
        {fileConversations}
      </div>
    );
  if (!diff || !loaded || !section)
    return (
      <div className="diff-scroll">
        <p role="status">Loading file diff…</p>
        {fileConversations}
      </div>
    );
  const { savedHunks: hunks } = diff;
  return (
    <>
      {loaded.error && (
        <p role="status">
          {loaded.error}{' '}
          {loaded.full === null &&
            loaded.saved &&
            (file.kind === 'partial'
              ? 'Showing the available part of the saved diff.'
              : 'Showing the saved diff.')}{' '}
          <button
            disabled={retryDisabled || attempt !== loaded.attempt}
            title={
              retryLocal ? 'Refresh the local review and reopen the full file diff' : undefined
            }
            onClick={retryLocal ?? (() => retry((n) => n + 1))}
          >
            {retryingRevision || attempt !== loaded.attempt
              ? 'Retrying file diff…'
              : retryLocal
                ? 'Refresh and retry file diff'
                : 'Retry file diff'}
          </button>
        </p>
      )}
      {hunks.length > 1 && (
        <div className="hunk-nav">
          <span>
            Change {file.hunk + 1} of {hunks.length}
          </span>
          <button
            className="secondary"
            disabled={file.hunk === 0}
            onClick={() => move(file, { hunk: file.hunk - 1, scroll: 0 })}
          >
            Previous change
          </button>
          <button
            className="secondary"
            disabled={file.hunk + 1 >= hunks.length}
            onClick={() => move(file, { hunk: file.hunk + 1, scroll: 0 })}
          >
            Next change
          </button>
        </div>
      )}
      {pageCount > 1 && (
        <div className="hunk-nav">
          <button disabled={currentPage === 0} onClick={() => choosePage(currentPage - 1)}>
            Previous page
          </button>
          <span>
            Page {currentPage + 1} of {pageCount}
          </span>
          <button
            disabled={currentPage + 1 === pageCount}
            onClick={() => choosePage(currentPage + 1)}
          >
            Next page
          </button>
        </div>
      )}
      {pinnedLinks}
      {reminders}
      {!diff.length ? (
        <div className="diff-scroll">
          {!loaded.error && <p className="patch-note">This file is empty.</p>}
          {fileConversations}
        </div>
      ) : (
        <Hunk
          key={currentPage}
          match={localMatch}
          ask={ask}
          controlRef={controlRef}
          claimFocus={claimFocus}
          index={file.hunk}
          jump={jump?.path === file.path ? jump : null}
          notes={notes}
          published={published}
          fileConversations={fileConversations}
          publishedLines={publishedLines}
          editorAnchor={editorAnchor}
          onRange={(range, hunk) => compose?.({ path: file.path, hunk, ...range }, '')}
          drafts={drafts}
          onComment={
            compose
              ? (side, line, hunk, excerpt, draft) =>
                  compose(
                    draft ??
                      (selection &&
                      selection.hunk === hunk &&
                      selection.side === side &&
                      line >= (selection.startLine ?? selection.line) &&
                      line <= selection.line
                        ? selection
                        : { path: file.path, hunk, side, line }),
                    excerpt,
                    draft,
                  )
              : undefined
          }
          selection={selection}
          onLine={(side, line, hunk, extend) =>
            onLine({ path: file.path, hunk, side, line }, extend)
          }
          diff={section}
          path={file.path}
          offset={
            Math.floor(file.scroll / filePageScroll) === currentPage ? file.scroll - offsetBase : 0
          }
          onScroll={(scroll) => move(file, { scroll: offsetBase + scroll })}
        />
      )}
    </>
  );
}

// What the reader's keyboard shortcuts can ask of the hunk on screen.
interface HunkControl {
  comment(): void;
}
function Hunk({
  match,
  ask,
  controlRef,
  claimFocus,
  index,
  diff,
  jump,
  path,
  offset,
  notes,
  published,
  publishedLines,
  fileConversations,
  editorAnchor,
  drafts,
  onComment,
  onRange,
  selection,
  onLine,
  onScroll,
}: {
  ask: () => void;
  controlRef: RefObject<HunkControl | null>;
  claimFocus: (path: string, hunk: number) => boolean;
  index: number;
  match: MatchSpan | null;
  diff: FileDiff;
  jump: { hunk: number } | null;
  path: string;
  offset: number;
  notes: Notes;
  published: Published;
  publishedLines: PublishedLines;
  fileConversations: ReactNode;
  editorAnchor: EditorAnchor;
  drafts: Draft[];
  onRange: (range: Pick<CommentAnchor, 'side' | 'line' | 'startLine'>, hunk: number) => void;
  onComment:
    | ((side: Anchor['side'], line: number, hunk: number, excerpt: string, draft?: Draft) => void)
    | undefined;
  selection: CommentAnchor | null;
  onLine: (side: Anchor['side'], line: number, hunk: number, extend: boolean) => void;
  onScroll: (n: number) => void;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const rowList = useRef<HTMLDivElement>(null);
  const { savedHunks: hunks, hunkAt, displayPosition } = diff;
  // A long hunk renders only the rows near the viewport. See useRowWindow.
  const windowed = shouldWindow(diff.length, hunkWindowThreshold);
  const drag = useCommentDrag(
    pane,
    (range) => {
      const start = diff.find(range.side, range.startLine ?? range.line);
      const end = diff.find(range.side, range.line);
      const hunk = hunkAt(end ?? -1, range.side);
      if (hunk >= 0 && hunk === hunkAt(start ?? -1, range.side)) onRange(range, hunk);
    },
    windowed,
  );
  const highlighted = drag.preview ?? selection;
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
  // Rows with a draft, an open editor, a published thread or an active drag stay rendered:
  // they hold state, and their measured heights keep every row's offset exact.
  const pinned = useMemo(() => {
    if (!windowed) return [];
    const rows = new Set<number>();
    const pin = (side: Anchor['side'], line: number) => {
      const row = diff.find(side, line);
      if (row !== undefined) rows.add(row);
    };
    for (const d of drafts) pin(d.side, d.line);
    for (const key of publishedLines.keys())
      pin(key.startsWith('LEFT:') ? 'old' : 'new', Number(key.slice(key.indexOf(':') + 1)));
    if (editorAnchor) pin(editorAnchor.side, editorAnchor.line);
    if (drag.origin) pin(drag.origin.side, drag.origin.line);
    return [...rows];
  }, [diff, windowed, drafts, publishedLines, editorAnchor, drag.origin]);
  const [initialScroll] = useState(offset);
  const { segments, reveal } = useRowWindow({
    enabled: windowed,
    count: diff.length,
    scroller: pane,
    list: rowList,
    pinned,
    initialScroll,
  });
  useLayoutEffect(() => {
    // A windowed hunk restores its position once its rows are measured.
    if (pane.current && !windowed) pane.current.scrollTop = initialScroll;
  }, [windowed, initialScroll]);
  const [initialHunk] = useState(initialScroll === 0 ? index : 0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (mounted.current && !jump) return;
    mounted.current = true;
    const hunk = jump?.hunk ?? initialHunk;
    if (!jump && !hunk) return;
    const row = displayPosition(hunk);
    if (row === undefined) return;
    if (windowed) reveal(row);
    else
      pane.current
        ?.querySelector('[data-diff-row="' + row + '"]')
        ?.scrollIntoView({ block: 'nearest' });
  }, [jump, initialHunk, displayPosition, windowed, reveal]);
  useLayoutEffect(() => {
    const composer = pane.current?.querySelector('.inline-composer textarea:focus');
    if (composer) composer.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    else if (selection && windowed) {
      const row = diff.find(selection.side, selection.startLine ?? selection.line);
      if (row !== undefined) reveal(row, '.diff-line');
    } else if (selection)
      pane.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selection, diff, windowed, reveal]);
  useLayoutEffect(() => {
    if (!match) return;
    if (windowed) reveal(match.row, '.code-line mark');
    else
      pane.current
        ?.querySelector('.code-line mark')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [match, windowed, reveal]);
  const lines = useMemo(() => {
    // Syntax highlighting has a character budget. Keep large, short-line files indexed too.
    if (diff.length > 50_000) return [];
    return Array.from({ length: diff.length }, (_, i) => diff.rowAt(i)).filter(
      (row) => row !== undefined,
    );
  }, [diff]);
  const syntax = useMemo(() => highlightRows(lines, languageFor(path)), [lines, path]);
  useEffect(() => {
    const api: HunkControl = {
      comment() {
        if (!onComment) return;
        if (selection) {
          const at = diff.find(selection.side, selection.line);
          const row = diff.rowAt(at ?? -1);
          if (row && hunkAt(at ?? -1, selection.side) === selection.hunk) {
            onComment(selection.side, selection.line, selection.hunk, row.text);
            return;
          }
        }
        const changed = diff.firstChange(index);
        const first = changed && firstChangedLine([changed]);
        if (first) onComment(first.side, first.line, index, first.text);
      },
    };
    controlRef.current = api;
    return () => {
      if (controlRef.current === api) controlRef.current = null;
    };
  }, [controlRef, onComment, selection, index, diff, hunkAt]);
  useLayoutEffect(() => {
    // Moving here by keyboard puts focus on the hunk so assistive technology follows.
    if (!claimFocus(path, index)) return;
    pane.current?.focus({ preventScroll: true });
    pane.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [claimFocus, path, index]);
  const windowHint = useId();
  // The line itself, then anything published or drafted beneath it. `plain` is true when
  // the row is only the line, so its height is the one every such row shares.
  function renderRow(line: (typeof lines)[number], i: number) {
    const oldHunk = hunkAt(i, 'old'),
      newHunk = hunkAt(i, 'new');
    const side = newHunk >= 0 ? 'new' : 'old';
    const hunk = side === 'new' ? newHunk : oldHunk;
    const number = side === 'new' ? line.newLine : line.oldLine;
    const oldComments = oldHunk < 0 ? [] : (notesByEnd.get('old:' + line.oldLine) ?? []);
    const newComments = newHunk < 0 ? [] : (notesByEnd.get('new:' + line.newLine) ?? []);
    const local = newComments[0] ?? oldComments[0];
    const selectedLine = highlighted?.side === 'old' ? line.oldLine : line.newLine;
    const tools =
      !!selection &&
      selection.hunk === (selection.side === 'old' ? oldHunk : newHunk) &&
      (selection.side === 'old' ? line.oldLine : line.newLine) === selection.line;
    const threads = published(line.oldLine, line.newLine);
    const oldNotes =
      oldHunk < 0 ? null : notes(line.oldLine, null, oldComments, hunks[oldHunk] ?? '', oldHunk);
    const newNotes =
      newHunk < 0 ? null : notes(null, line.newLine, newComments, hunks[newHunk] ?? '', newHunk);
    return {
      plain: !tools && !threads && !oldNotes && !newNotes,
      content: (
        <>
          <div
            data-diff-row={i}
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
              {onComment && hunk >= 0 && number !== null && (
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
                    onComment(local?.side ?? side, local?.line ?? number, hunk, line.text, local);
                  }}
                >
                  <MessageSquarePlus size={13} />
                </button>
              )}
            </span>
            <span className="gutter">
              {oldHunk < 0
                ? line.oldLine
                : line.oldLine !== null && (
                    <button
                      aria-label={'Select old line ' + line.oldLine}
                      title="Shift-click to select a range"
                      onClick={(e) => {
                        if (line.oldLine !== null) onLine('old', line.oldLine, oldHunk, e.shiftKey);
                      }}
                    >
                      {line.oldLine}
                    </button>
                  )}
            </span>
            <span className="gutter">
              {newHunk < 0
                ? line.newLine
                : line.newLine !== null && (
                    <button
                      aria-label={'Select new line ' + line.newLine}
                      title="Shift-click to select a range"
                      onClick={(e) => {
                        if (line.newLine !== null) onLine('new', line.newLine, newHunk, e.shiftKey);
                      }}
                    >
                      {line.newLine}
                    </button>
                  )}
            </span>
            <CodeLine
              text={line.text}
              tokens={syntax[i] ?? null}
              match={match?.row === i ? match : null}
            />
            {selection && tools && (
              <span className="line-tools">
                <button
                  className="secondary"
                  disabled={!onComment}
                  aria-label={
                    selection.startLine && selection.startLine !== selection.line
                      ? 'Comment on lines ' + selection.startLine + '–' + selection.line
                      : 'Comment on line'
                  }
                  onClick={() =>
                    onComment?.(selection.side, selection.line, selection.hunk, line.text)
                  }
                >
                  <MessageSquare size={13} /> Comment
                </button>
                <button className="secondary" onClick={ask}>
                  <Sparkles size={13} /> Ask assistant
                </button>
              </span>
            )}
          </div>
          {threads}
          {oldNotes}
          {newNotes}
        </>
      ),
    };
  }
  return (
    <div
      ref={pane}
      className="diff-scroll"
      role="region"
      aria-label="File diff"
      aria-describedby={segments ? windowHint : undefined}
      tabIndex={0}
      onScroll={(e) => {
        const top = Math.round(e.currentTarget.scrollTop);
        if (top !== offset) onScroll(top);
      }}
    >
      <div className="diff-content">
        {segments ? (
          <>
            <p id={windowHint} className="visually-hidden">
              This file diff has {diff.length} lines. Lines load as you scroll. Use Search diff to
              find text in lines that are not loaded.
            </p>
            <div
              ref={rowList}
              className="diff-rows"
              role="list"
              aria-label={diff.length + ' diff lines'}
            >
              {/* Holds the pane as wide as the longest line while that line is not rendered. */}
              <div className="diff-sizer" role="presentation" aria-hidden="true">
                <span className="comment-gutter" />
                <span className="gutter" />
                <span className="gutter" />
                <span className="code-line">{diff.widest}</span>
              </div>
              {segments.map((segment) => {
                if (segment.kind === 'gap')
                  return (
                    <div key={segment.key} role="presentation" style={{ height: segment.height }} />
                  );
                const line = diff.rowAt(segment.index);
                if (!line) return null;
                const row = renderRow(line, segment.index);
                return (
                  <div
                    key={segment.index}
                    role="listitem"
                    aria-setsize={diff.length}
                    aria-posinset={segment.index + 1}
                    data-row={segment.index}
                    data-plain={row.plain ? '' : undefined}
                  >
                    {row.content}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          lines.map((line, i) => <Fragment key={i}>{renderRow(line, i).content}</Fragment>)
        )}
      </div>
      {fileConversations}
    </div>
  );
}
