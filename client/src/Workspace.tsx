import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './components/Resizable.js';
import { SettingsPane, RepliesPane, applyTypography } from './WorkspacePanels.js';
import type { Inbox as ReplyInbox, Typography } from '../../shared/workspace.js';
import {
  readableError,
  type AgentCatalog,
  type AgentId,
  type Selection,
  type Repository,
} from '../../shared/assistant.js';
import { AgentPicker } from './components/AgentPicker.js';
import { useScrollIndicators } from './useScrollIndicators.js';
import type { Accent, Appearance } from '../../shared/appearance.js';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { isInactivePull, pullRequestUrl, type SavedReview } from '../../shared/reviews.js';
import { readReviewLayout } from './reviewLayouts.js';
import { ReviewLayoutPicker } from './components/ReviewLayoutPicker.js';
import { RepositorySidebar } from './RepositorySidebar.js';
import { GitPullRequest, Link2, Plus } from 'lucide-react';
import { LocalReviewStart } from './LocalReview.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import { groupReviews, reviewRepository } from '../../shared/repository-groups.js';
import { PullRequestQueue } from './PullRequestQueue.js';
import { ReviewRequests } from './ReviewRequests.js';
import type { ReviewRequestInbox } from '../../shared/review-requests.js';
import { Reader, type PrCommand } from './Reader.js';

const emptyInbox: ReplyInbox = {
  account: null,
  items: [],
  changes: [],
  added: 0,
  error: null,
};
export function Workspace({
  initialVibrancy,
  initialShortcuts,
  initialTheme,
  initialAccent,
  initialType,
}: {
  initialVibrancy: boolean;
  initialShortcuts: boolean;
  initialTheme: Appearance;
  initialAccent: Accent;
  initialType: Typography;
}) {
  useScrollIndicators();
  const [layout, setLayout] = useState(readReviewLayout);
  const [theme, setTheme] = useState(initialTheme);
  const [appearanceError, setAppearanceError] = useState('');
  const [vibrancy, setVibrancy] = useState(initialVibrancy);
  const [savingVibrancy, setSavingVibrancy] = useState(false);
  function chooseVibrancy(enabled: boolean) {
    setSavingVibrancy(true);
    setVibrancy(enabled);
    window.reviewer
      .saveSidebarVibrancy(enabled)
      .then(() => {
        document.documentElement.classList.toggle('sidebar-vibrancy', enabled);
        setAppearanceError('');
      })
      .catch(() => {
        setVibrancy(!enabled);
        setAppearanceError('Could not save sidebar vibrancy. Please try again.');
      })
      .finally(() => setSavingVibrancy(false));
  }
  const [shortcuts, setShortcuts] = useState(initialShortcuts);
  const [savingShortcuts, setSavingShortcuts] = useState(false);
  function chooseShortcuts(enabled: boolean) {
    setSavingShortcuts(true);
    setShortcuts(enabled);
    window.reviewer
      .saveSingleKeyShortcuts(enabled)
      .then(() => setAppearanceError(''))
      .catch(() => {
        setShortcuts(!enabled);
        setAppearanceError('Could not save the shortcuts setting. Please try again.');
      })
      .finally(() => setSavingShortcuts(false));
  }
  function chooseTheme(next: Appearance) {
    window.reviewer
      .saveAppearance(next)
      .then(() => {
        document.documentElement.dataset.palette = next;
        setTheme(next);
        setAppearanceError('');
      })
      .catch(() => setAppearanceError('Could not save appearance. Please try again.'));
  }
  const [accent, setAccent] = useState(initialAccent);
  function chooseAccent(next: Accent) {
    window.reviewer
      .saveAccent(next)
      .then(() => {
        document.documentElement.dataset.accent = next;
        setAccent(next);
        setAppearanceError('');
      })
      .catch(() => setAppearanceError('Could not save the accent colour. Please try again.'));
  }
  const [agents, setAgents] = useState<AgentCatalog | null>(null);
  const [agentError, setAgentError] = useState('');
  const [agentLoad, setAgentLoad] = useState(0);
  const agentSave = useRef(0);
  useEffect(() => {
    let active = true;
    const turn = agentSave.current;
    window.reviewer
      .agentSelection()
      .then((catalog) => {
        if (!active || turn !== agentSave.current) return;
        setAgents(catalog);
        setAgentError('');
      })
      .catch((e) => {
        if (active && turn === agentSave.current) setAgentError(readableError(e));
      });
    return () => {
      active = false;
    };
  }, [agentLoad]);
  function chooseAgent(next: Selection) {
    // Show the choice at once. Only the latest save may replace it.
    const turn = ++agentSave.current;
    setAgents((current) => current && { ...current, selection: next });
    window.reviewer
      .saveSelection(next)
      .then((catalog) => {
        if (turn !== agentSave.current) return;
        setAgents(catalog);
        setAgentError('');
      })
      .catch(async (e: unknown) => {
        if (turn !== agentSave.current) return;
        setAgentError('Could not save the harness and model. ' + readableError(e));
        // Questions run with the stored choice, so show that one again.
        const stored = await window.reviewer.agentSelection().catch(() => null);
        if (stored && turn === agentSave.current) setAgents(stored);
      });
  }
  function chooseExecutable(agent: AgentId) {
    window.reviewer
      .chooseExecutable(agent)
      .then((chosen) => {
        if (chosen) setAgentLoad((n) => n + 1);
      })
      .catch((e) => setAgentError(readableError(e)));
  }
  const agentPicker = (
    <AgentPicker
      catalog={agents}
      error={agentError}
      onChange={chooseAgent}
      onChooseExecutable={chooseExecutable}
      onRetry={() => setAgentLoad((n) => n + 1)}
    />
  );
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [reviews, setReviews] = useState<SavedReview[] | null>(null);
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [chosenRepo, setChosenRepo] = useState<string | null>(null);
  const [newReview, setNewReview] = useState(false);
  // Which list the main pane shows while no review is open.
  const [queue, setQueue] = useState<'repository' | 'requests'>('repository');
  const [requests, setRequests] = useState<ReviewRequestInbox | null>(null);
  const [requestsBusy, setRequestsBusy] = useState(false);
  const [requestEpoch, setRequestEpoch] = useState(0);
  useEffect(() => {
    let alive = true,
      running = false,
      last = 0;
    async function poll(force: boolean) {
      if (running || (!force && Date.now() - last < 115000)) return;
      running = true;
      last = Date.now();
      try {
        // The saved list is shown at once and stays if GitHub cannot be reached.
        const saved = await window.reviewer.reviewRequests();
        if (alive) setRequests(saved);
        const next = await window.reviewer.syncReviewRequests();
        if (alive) setRequests(next);
      } catch (e) {
        const message = readableError(e);
        if (alive)
          setRequests((current) =>
            current?.state === 'listed'
              ? { ...current, error: message }
              : { state: 'unavailable', message },
          );
      } finally {
        running = false;
        if (alive) setRequestsBusy(false);
      }
    }
    void poll(true);
    const timer = window.setInterval(() => void poll(false), 120000);
    const focus = () => void poll(false);
    window.addEventListener('focus', focus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [requestEpoch]);
  const refreshRequests = useCallback(() => {
    setRequestsBusy(true);
    setRequestEpoch((n) => n + 1);
  }, []);
  // Opening a PR clears its new mark in the main process, so read the saved list again.
  useEffect(() => {
    let alive = true;
    window.reviewer
      .reviewRequests()
      .then((saved) => {
        if (alive) setRequests((current) => (current === null ? current : saved));
      })
      .catch(() => {
        /* The regular refresh reports list errors. */
      });
    return () => {
      alive = false;
    };
  }, [activeUrl]);
  const listedRequests = requests?.state === 'listed' ? requests.requests : null;
  const groups = useMemo(() => groupReviews(repos ?? [], reviews ?? []), [repos, reviews]);
  const selectedRepo = activeUrl
    ? reviewRepository(activeUrl, reviews?.find((item) => item.url === activeUrl)?.local)
    : chosenRepo && groups.has(chosenRepo)
      ? chosenRepo
      : (groups.keys().next().value ?? null);
  const selectedGroup = selectedRepo ? groups.get(selectedRepo) : undefined;
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([window.reviewer.listReviews(), window.reviewer.activeReview()])
      .then(([items, selected]) => {
        if (active) {
          setReviews(items);
          setActiveUrl(selected);
          if (selected)
            setChosenRepo(
              reviewRepository(selected, items.find((item) => item.url === selected)?.local),
            );
        }
      })
      .catch(() => {
        if (active) setError('Could not load the workspace. Reopen the app to try again.');
      });
    return () => {
      active = false;
    };
  }, []);

  function updateReviewLabels(saved: SavedReview[]) {
    const byUrl = new Map(saved.map((item) => [item.url, item]));
    setReviews((current) => {
      if (
        !current?.some((item) => {
          const next = byUrl.get(item.url);
          return (
            next &&
            (next.state !== item.state ||
              next.isDraft !== item.isDraft ||
              next.title !== item.title ||
              next.author !== item.author ||
              next.openedAt !== item.openedAt ||
              next.head !== item.head ||
              next.commitCount !== item.commitCount ||
              next.approvalStage !== item.approvalStage)
          );
        })
      )
        return current;
      return current.map((item) => byUrl.get(item.url) ?? item);
    });
  }
  const refreshReviewLabels = useCallback(() => {
    window.reviewer
      .listReviews()
      .then(updateReviewLabels)
      .catch((e) => setError(readableError(e)));
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const repliesButton = useRef<HTMLButtonElement>(null);
  const [type, setType] = useState(initialType);
  const [inbox, setInbox] = useState(emptyInbox);
  const [checking, setChecking] = useState(false);
  const poll = useRef({ running: false, again: false, generation: 0 });
  const refresh = useCallback(() => {
    const job = poll.current;
    if (job.running) {
      job.again = true;
      return;
    }
    job.running = true;
    setChecking(true);
    async function drain() {
      try {
        do {
          job.again = false;
          const generation = job.generation;
          try {
            const next = await window.reviewer.syncReplies();
            if (generation !== job.generation) continue;
            setInbox(next);
            const [saved, monitored] = await Promise.all([
              window.reviewer.listReviews(),
              window.reviewer.repositories().catch(() => null),
            ]);
            if (generation === job.generation) {
              updateReviewLabels(saved);
              if (monitored) setRepos(monitored);
            }
          } catch (e) {
            if (generation === job.generation) {
              setInbox({ ...emptyInbox, error: readableError(e) });
            }
          }
        } while (job.again);
      } finally {
        job.running = false;
        setChecking(false);
      }
    }
    void drain();
  }, []);
  const invalidateInbox = useCallback(() => {
    poll.current.generation++;
    setInbox(emptyInbox);
  }, []);
  const savedUrls = reviews?.map((item) => item.url).join(' ');
  useEffect(() => {
    if (savedUrls === undefined) return;
    refresh();
    let last = Date.now();
    const check = () => {
      if (Date.now() - last >= 60000) {
        last = Date.now();
        refresh();
      }
    };
    const timer = window.setInterval(check, 120000);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [savedUrls, refresh]);
  const desiredType = useRef(initialType),
    typeQueue = useRef(Promise.resolve()),
    confirmedType = useRef(initialType);
  function chooseType(change: Partial<Typography>) {
    const next = { ...desiredType.current, ...change };
    desiredType.current = next;
    setType(next);
    applyTypography(next);
    typeQueue.current = typeQueue.current.then(async () => {
      try {
        confirmedType.current = await window.reviewer.saveTypography(next);
        if (desiredType.current === next) setAppearanceError('');
      } catch (e) {
        if (desiredType.current !== next) return;
        const saved = confirmedType.current;
        desiredType.current = saved;
        setType(saved);
        applyTypography(saved);
        setAppearanceError(readableError(e));
      }
    });
  }
  function refreshInbox() {
    invalidateInbox();
    refresh();
  }
  function openInbox() {
    refreshInbox();
    setRepliesOpen(true);
  }
  // A sidebar action to carry out once its PR is open. Opening anything else drops it.
  const [command, setCommand] = useState<PrCommand | null>(null);
  const [reviewEpoch, setReviewEpoch] = useState(0);
  const commandId = useRef(0);
  const navigation = useRef(0);
  function select(
    url: string | null,
    kind: PrCommand['kind'] | null = null,
    request = ++navigation.current,
  ) {
    setError('');
    window.reviewer
      .selectReview(url)
      .then(() => {
        if (request !== navigation.current) return;
        setActiveUrl(url);
        if (!url) refreshReviewLabels();
        setCommand(url && kind ? { id: ++commandId.current, url, kind } : null);
      })
      .catch(() => {
        if (request === navigation.current)
          setError('Could not change the active review. Try again.');
      });
  }

  function openSaved(pr: string) {
    setRepliesOpen(false);
    setQueue('repository');
    select(pr);
  }
  function chooseRepository(key: string) {
    setChosenRepo(key);
    setQueue('repository');
    setRepliesOpen(false);
    select(null);
  }
  function chooseRequests() {
    setQueue('requests');
    setRepliesOpen(false);
    select(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !reviews) return;
    const parsed = pullRequestUrl.safeParse(url);
    if (!parsed.success) {
      setError('Enter a GitHub pull request URL, such as https://github.com/owner/repo/pull/123.');
      return;
    }
    setError('');
    setBusy(true);
    window.reviewer
      .saveReview(parsed.data)
      .then((items) => {
        setReviews(items);
        setUrl('');
        setNewReview(false);
        if (isInactivePull(items.find((item) => item.url === parsed.data)?.state))
          openSaved(parsed.data);
        else chooseRepository(reviewRepository(parsed.data));
      })
      .catch(() => setError('Could not save this pull request. Your link is still here.'))
      .finally(() => setBusy(false));
  }

  // `origin` is the list that Back returns to.
  function openPull(pr: string, kind: PrCommand['kind'] | null, origin: typeof queue) {
    const request = ++navigation.current;
    window.reviewer
      .saveReview(pr)
      .then((items) => {
        if (request !== navigation.current) return;
        setReviews(items);
        setChosenRepo(reviewRepository(pr));
        setQueue(origin);
        setRepliesOpen(false);
        select(pr, kind, request);
      })
      .catch((e) => {
        if (request === navigation.current) setError(readableError(e));
      });
  }
  const openMonitored = (pr: string, kind: PrCommand['kind'] | null = null) =>
    openPull(pr, kind, 'repository');
  // A notification about a new pull request opens it when clicked.
  const openFromAlert = useEffectEvent((pr: string) => {
    openMonitored(pr);
    refresh();
  });
  useEffect(() => window.reviewer.onOpenPr((pr) => openFromAlert(pr)), []);
  return (
    <>
      <ResizablePanelGroup id="workspace-layout" className="studio">
        <ResizablePanel
          id="workspace-sidebar"
          defaultSize="19%"
          minSize="202px"
          maxSize="36%"
          groupResizeBehavior="preserve-pixel-size"
        >
          <RepositorySidebar
            layoutPicker={<ReviewLayoutPicker layout={layout} onChange={setLayout} />}
            openInbox={() => (repliesOpen ? setRepliesOpen(false) : openInbox())}
            openSettings={() => {
              setSettingsOpen(true);
              refresh();
            }}
            repliesButton={repliesButton}
            repliesPane={
              repliesOpen && (
                <RepliesPane
                  inbox={inbox}
                  openPr={openMonitored}
                  busy={checking}
                  update={(i) =>
                    setInbox((current) => (current.account === i.account ? i : current))
                  }
                  refresh={refreshInbox}
                  settings={() => setSettingsOpen(true)}
                  close={() => {
                    setRepliesOpen(false);
                    repliesButton.current?.focus();
                  }}
                />
              )
            }
            unread={[...inbox.items, ...inbox.changes].filter((i) => i.unread).length}
            repos={repos ?? []}
            setRepos={setRepos}
            groups={[...groups.values()]}
            openSaved={openSaved}
            openMonitored={openMonitored}
            selectedRepo={queue === 'requests' && !activeUrl ? null : selectedRepo}
            chooseRepository={chooseRepository}
            requestCount={listedRequests?.length ?? null}
            newRequests={listedRequests?.filter((request) => request.unseen).length ?? 0}
            requestsSelected={queue === 'requests' && !activeUrl && !repliesOpen}
            chooseRequests={chooseRequests}
            activeUrl={activeUrl}
            refresh={reviewEpoch}
            refreshSavedStatuses={refresh}
          />
        </ResizablePanel>
        <ResizableHandle label="Resize repository sidebar" />
        <ResizablePanel id="workspace-page" className="studio-page">
          <span role="status" className="visually-hidden">
            {inbox.added > 0 &&
              (inbox.added === 1 ? '1 new review alert' : inbox.added + ' new review alerts')}
          </span>
          {settingsOpen && (
            <SettingsPane
              theme={theme}
              chooseTheme={chooseTheme}
              vibrancy={vibrancy}
              savingVibrancy={savingVibrancy}
              chooseVibrancy={chooseVibrancy}
              shortcuts={shortcuts}
              savingShortcuts={savingShortcuts}
              chooseShortcuts={chooseShortcuts}
              accent={accent}
              chooseAccent={chooseAccent}
              type={type}
              chooseType={chooseType}
              onLoginStart={invalidateInbox}
              onConnected={() => {
                refresh();
                refreshRequests();
              }}
              close={() => setSettingsOpen(false)}
              error={appearanceError}
            />
          )}
          {appearanceError && <p role="alert">{appearanceError}</p>}
          {agentError && <p role="alert">{agentError}</p>}
          {activeUrl && error && <p role="alert">{error}</p>}
          {activeUrl ? (
            <Reader
              layout={layout}
              accountEpoch={inbox.account}
              agentPicker={agentPicker}
              singleKeyShortcuts={shortcuts}
              agents={agents}
              command={command?.url === activeUrl ? command : null}
              local={reviews?.find((item) => item.url === activeUrl)?.local ?? null}
              onSnapshotSaved={refreshReviewLabels}
              onPublished={() => {
                setReviewEpoch((n) => n + 1);
                refresh();
              }}
              key={activeUrl}
              url={activeUrl}
              onBack={() => {
                if (selectedRepo) setChosenRepo(selectedRepo);
                select(null);
              }}
            />
          ) : (
            <div className="shell queue-page">
              <header className="home-bar">
                <h1>
                  {queue === 'requests'
                    ? 'Review requests'
                    : reviews?.some((item) => item.local?.path === selectedRepo)
                      ? 'Local reviews'
                      : 'Pull requests'}
                </h1>
                <button
                  className="open-review"
                  onClick={() => {
                    setError('');
                    setNewReview(true);
                  }}
                >
                  <Plus size={15} /> Open review
                </button>
              </header>
              <main>
                {error && !newReview && <p role="alert">{error}</p>}
                {queue === 'requests' ? (
                  <ReviewRequests
                    inbox={requests}
                    busy={requestsBusy}
                    refresh={refreshRequests}
                    open={(pr, kind) => openPull(pr, kind ?? null, 'requests')}
                    openSettings={() => setSettingsOpen(true)}
                    onError={setError}
                  />
                ) : (repos === null && !selectedRepo) || reviews === null ? (
                  <p role="status">{error ? 'Workspace unavailable.' : 'Loading workspace…'}</p>
                ) : selectedGroup ? (
                  <PullRequestQueue
                    group={selectedGroup}
                    onError={setError}
                    open={openMonitored}
                    openSaved={openSaved}
                  />
                ) : (
                  <div className="queue-empty">
                    <GitPullRequest size={26} />
                    <h2>Add your first repository</h2>
                    <p>
                      Use the + beside Repositories to follow pull requests, or open a review by
                      URL.
                    </p>
                  </div>
                )}
              </main>
              {newReview && (
                <WorkspaceDialog
                  title="Open review"
                  onClose={() => setNewReview(false)}
                  busy={busy}
                >
                  <form className="pr-entry" onSubmit={submit}>
                    <label htmlFor="pr-url">
                      <Link2 size={16} /> GitHub pull request URL
                    </label>
                    <div className="entry">
                      <input
                        id="pr-url"
                        type="text"
                        inputMode="url"
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="https://github.com/owner/repo/pull/123"
                        value={url}
                        disabled={busy}
                        onChange={(event) => setUrl(event.target.value)}
                        required
                      />
                      <button type="submit" disabled={busy || reviews === null}>
                        {busy ? 'Saving…' : 'Save pull request'}
                      </button>
                    </div>
                  </form>
                  <LocalReviewStart
                    disabled={reviews === null}
                    onStarted={(started, items) => {
                      setReviews(items);
                      setNewReview(false);
                      setQueue('repository');
                      setChosenRepo(
                        reviewRepository(
                          started,
                          items.find((item) => item.url === started)?.local,
                        ),
                      );
                      select(started);
                    }}
                  />
                  {error && <p role="alert">{error}</p>}
                </WorkspaceDialog>
              )}
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
