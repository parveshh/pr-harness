import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './components/Resizable.js';
import { SettingsPane, RepliesPane, applyTypography } from './WorkspacePanels.js';
import type { Inbox as ReplyInbox, Typography } from '../../shared/workspace.js';
import {
  readableError,
  type AgentCatalog,
  type AgentId,
  type Selection,
} from '../../shared/assistant.js';
import { AgentPicker } from './components/AgentPicker.js';
import { useScrollIndicators } from './useScrollIndicators.js';
import type { Accent, Appearance } from '../../shared/appearance.js';
import { useCallback, useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { pullRequestUrl, type SavedReview } from '../../shared/reviews.js';
import { RepositorySidebar } from './RepositorySidebar.js';
import { GitPullRequest, Layers2, ChevronRight, Link2, Bell, X } from 'lucide-react';
import { EmptyState } from './components/EmptyState.js';
import { Reader, type PrCommand } from './Reader.js';

const emptyInbox: ReplyInbox = { account: null, items: [], added: 0, error: null };
export function Workspace({
  initialTheme,
  initialAccent,
  initialType,
}: {
  initialTheme: Appearance;
  initialAccent: Accent;
  initialType: Typography;
}) {
  useScrollIndicators();
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('repository-sidebar-collapsed') !== 'false';
    } catch {
      return true;
    }
  });
  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem('repository-sidebar-collapsed', String(next));
    } catch {
      // Keep the current window usable when layout preferences cannot be stored.
    }
  }
  const [appearanceError, setAppearanceError] = useState('');
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
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([window.reviewer.listReviews(), window.reviewer.activeReview()])
      .then(([items, selected]) => {
        if (active) {
          setReviews(items);
          setActiveUrl(selected);
        }
      })
      .catch(() => {
        if (active) setError('Could not load the workspace. Reopen the app to try again.');
      });
    return () => {
      active = false;
    };
  }, []);

  const [panel, setPanel] = useState<'settings' | 'replies' | null>(null);
  const [type, setType] = useState(initialType);
  const [inbox, setInbox] = useState(emptyInbox);
  const [checking, setChecking] = useState(false),
    [toast, setToast] = useState('');
  const poll = useRef({ running: false, again: false, generation: 0 });
  const inboxAccount = useRef<string | null>(null);
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
            if (inboxAccount.current !== next.account || !next.account) setToast('');
            inboxAccount.current = next.account;
            if (next.added)
              setToast(
                next.added === 1 ? '1 new review reply' : next.added + ' new review replies',
              );
          } catch (e) {
            if (generation === job.generation) {
              setInbox({ ...emptyInbox, error: readableError(e) });
              setToast('');
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
    inboxAccount.current = null;
    setInbox(emptyInbox);
    setToast('');
  }, []);
  useEffect(() => {
    if (reviews === null) return;
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
  }, [reviews, refresh]);
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
    setPanel('replies');
  }
  // A sidebar action to carry out once its PR is open. Opening anything else drops it.
  const [command, setCommand] = useState<PrCommand | null>(null);
  const [reviewEpoch, setReviewEpoch] = useState(0);
  const commandId = useRef(0);
  function select(url: string | null, kind: PrCommand['kind'] | null = null) {
    window.reviewer
      .selectReview(url)
      .then(() => {
        setActiveUrl(url);
        setCommand(url && kind ? { id: ++commandId.current, url, kind } : null);
      })
      .catch(() => setError('Could not change the active review. Try again.'));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !reviews) return;
    setNotice('');
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
        setNotice(
          reviews.some((item) => item.url === parsed.data)
            ? 'Already in your workspace.'
            : 'Pull request saved.',
        );
      })
      .catch(() => setError('Could not save this pull request. Your link is still here.'))
      .finally(() => setBusy(false));
  }

  function openMonitored(pr: string, kind: PrCommand['kind'] | null = null) {
    window.reviewer
      .saveReview(pr)
      .then((items) => {
        setReviews(items);
        select(pr, kind);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not open the PR.'));
  }
  // A notification about a new pull request opens it when clicked.
  const openFromAlert = useEffectEvent((pr: string) => openMonitored(pr));
  useEffect(() => window.reviewer.onOpenPr((pr) => openFromAlert(pr)), []);
  return (
    <ResizablePanelGroup
      id="workspace-layout"
      className="studio"
      data-sidebar-collapsed={collapsed}
      disabled={collapsed}
    >
      <ResizablePanel
        id="workspace-sidebar"
        defaultSize={window.reviewer.integratedTitleBar ? '290px' : '250px'}
        minSize={window.reviewer.integratedTitleBar ? '245px' : '175px'}
        maxSize="46%"
        groupResizeBehavior="preserve-pixel-size"
      >
        <RepositorySidebar
          openSettings={() => {
            setPanel('settings');
            refresh();
          }}
          openInbox={openInbox}
          unread={inbox.items.filter((i) => i.unread).length}
          collapsed={collapsed}
          onToggle={toggleSidebar}
          activeUrl={activeUrl}
          onOpen={openMonitored}
          onSummarise={(pr) => openMonitored(pr, 'summarise')}
          onApprove={(pr) => openMonitored(pr, 'approve')}
          refresh={reviewEpoch}
          onHome={() => select(null)}
        />
      </ResizablePanel>
      <ResizableHandle label="Resize repository sidebar" disabled={collapsed} />
      <ResizablePanel id="workspace-page" className="studio-page">
        {panel === 'settings' && (
          <SettingsPane
            theme={theme}
            chooseTheme={chooseTheme}
            accent={accent}
            chooseAccent={chooseAccent}
            type={type}
            chooseType={chooseType}
            onLoginStart={invalidateInbox}
            onConnected={refresh}
            close={() => setPanel(null)}
            error={appearanceError}
          />
        )}
        {panel === 'replies' && (
          <RepliesPane
            inbox={inbox}
            busy={checking}
            update={(i) => {
              setInbox((current) => (current.account === i.account ? i : current));
              setToast('');
            }}
            refresh={refreshInbox}
            settings={() => setPanel('settings')}
            close={() => {
              setPanel(null);
              setToast('');
            }}
          />
        )}
        {toast && panel !== 'replies' && (
          <div className="reply-toast" role="status">
            <Bell size={16} />
            <button onClick={openInbox}>{toast}</button>
            <button aria-label="Dismiss reply alert" onClick={() => setToast('')}>
              <X size={14} />
            </button>
          </div>
        )}

        {appearanceError && <p role="alert">{appearanceError}</p>}
        {agentError && <p role="alert">{agentError}</p>}
        {activeUrl ? (
          <Reader
            accountEpoch={inbox.account}
            headerAction={agentPicker}
            agents={agents}
            command={command?.url === activeUrl ? command : null}
            onPublished={() => setReviewEpoch((n) => n + 1)}
            key={activeUrl}
            url={activeUrl}
            onBack={() => select(null)}
          />
        ) : (
          <div className="shell">
            <header className="home-bar">
              <Layers2 size={16} /> Workspace {agentPicker}
            </header>
            <main>
              <h1>Review workspace</h1>
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
              {error && <p role="alert">{error}</p>}
              <p className="notice" role="status">
                {notice}
              </p>
              <section aria-labelledby="saved">
                <h2 id="saved">Saved pull requests {reviews && <span>{reviews.length}</span>}</h2>
                {reviews === null ? (
                  <p>{error ? 'Workspace unavailable.' : 'Loading workspace…'}</p>
                ) : reviews.length === 0 ? (
                  <EmptyState
                    visual={<GitPullRequest size={24} />}
                    title="Your first review starts here"
                    description="Save a pull request above to keep its diff, reading position, and conversation together."
                  />
                ) : (
                  <ul>
                    {reviews.map((item) => (
                      <li key={item.url}>
                        <button className="saved-link" onClick={() => select(item.url)}>
                          <GitPullRequest size={16} />
                          <strong>
                            {new URL(item.url).pathname.split('/').slice(1, 3).join('/')}
                          </strong>{' '}
                          <code>#{item.url.split('/').at(-1)}</code>
                          <time dateTime={item.savedAt}>
                            {new Date(item.savedAt).toLocaleDateString()}
                          </time>
                          <ChevronRight size={15} aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </main>
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
