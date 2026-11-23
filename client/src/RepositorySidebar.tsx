import { CrossPrComparison } from './CrossPrComparison.js';
import { useEffect, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Button, Dialog, DialogTrigger, Input, Popover, TextField } from 'react-aria-components';
import { login, readableError, repoName, type Repository } from '../../shared/assistant.js';

import {
  BookMarked,
  ChevronDown,
  Search,
  GitPullRequest,
  GitCompareArrows,
  Layers2,
  MoreHorizontal,
  Folders,
  Plus,
  HardDrive,
  Bell,
  Settings,
  Sparkles,
  CircleCheck,
  ListChecks,
  LoaderCircle,
} from 'lucide-react';
import { useWorkingPrs } from './chatRuns.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';

export function RepositorySidebar({
  onOpen,
  onSummarise,
  onReview,
  onApprove,
  refresh,
  onHome,
  activeUrl,
  collapsed,
  onToggle,
  openInbox,
  repliesButton,
  repliesPane,
  settingsOpen,
  onReturn,
  returnTo,
  openSettings,
  unread,
}: {
  onOpen: (url: string) => void;
  onReview: (url: string) => void;
  onSummarise: (url: string) => void;
  onApprove: (url: string) => void;
  // Changes when the PR list should be read from GitHub again, such as after a review.
  refresh: number;
  onHome: () => void;
  activeUrl: string | null;
  collapsed: boolean;
  onToggle: () => void;
  openInbox: () => void;
  repliesButton: RefObject<HTMLButtonElement | null>;
  repliesPane: ReactNode;
  settingsOpen: boolean;
  // Shows the open review again, or reopens the one the reviewer left for the workspace.
  onReturn: () => void;
  returnTo: string | null;
  openSettings: () => void;
  unread: number;
}) {
  const [repos, setRepos] = useState<Repository[]>([]),
    [adding, setAdding] = useState(false),
    [name, setName] = useState(''),
    [comparison, setComparison] = useState<string | null>(null),
    [manage, setManage] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const workingPrs = useWorkingPrs();
  const repositoriesOpen = !collapsed && !repliesPane;
  const selected = repos.find((r) => r.name === manage);
  function openAdd() {
    setError('');
    setName('');
    setAdding(true);
  }
  useEffect(() => {
    let alive = true,
      running = false,
      last = 0;
    async function poll() {
      if (running || Date.now() - last < 115000) return;
      running = true;
      last = Date.now();
      try {
        const cached = await window.reviewer.repositories();
        if (!alive) return;
        setRepos(cached);
        for (const r of cached) {
          if (!alive) break;
          if (r.watching.length) {
            const next = await window.reviewer.syncRepository(r.name, false);
            if (alive) setRepos(next);
          }
        }
      } catch (e) {
        if (alive) setError(readableError(e));
      } finally {
        running = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 120000);
    const focus = () => void poll();
    window.addEventListener('focus', focus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  // Opening a PR clears its new mark in the main process. Read the saved list again so the
  // highlight does not return when the reviewer leaves the PR.
  useEffect(() => {
    let alive = true;
    window.reviewer
      .repositories()
      .then((rows) => {
        if (alive) setRepos(rows);
      })
      .catch(() => {
        /* The regular refresh reports list errors. */
      });
    return () => {
      alive = false;
    };
  }, [activeUrl]);
  function update(work: () => Promise<Repository[]>, done?: () => void) {
    setBusy(true);
    setError('');
    work()
      .then((rows) => {
        setRepos(rows);
        done?.();
      })
      .catch((e) => setError(readableError(e)))
      .finally(() => setBusy(false));
  }
  function add(e: FormEvent) {
    e.preventDefault();
    const parsed = repoName.safeParse(name);
    if (!parsed.success) {
      setError('Enter owner/repository or its GitHub URL.');
      return;
    }
    if (busy) return;
    update(
      () => window.reviewer.addRepository(parsed.data),
      () => {
        setName('');
        setAdding(false);
        setManage(parsed.data);
      },
    );
  }
  return (
    <aside
      className={'repo-sidebar' + (collapsed ? ' collapsed' : '')}
      aria-label="Repository sidebar"
    >
      <nav className="workspace-rail" aria-label="Workspace tools">
        <button
          onClick={onHome}
          aria-label="Workspace"
          title="Workspace"
          aria-current={!activeUrl ? 'page' : undefined}
        >
          <Layers2 size={21} />
        </button>
        <button
          onClick={activeUrl || returnTo ? onReturn : undefined}
          aria-disabled={!activeUrl && !returnTo ? true : undefined}
          aria-label={
            activeUrl || returnTo ? 'Review' : 'Review, open one from the workspace first'
          }
          title={
            activeUrl
              ? 'Review'
              : returnTo
                ? 'Return to your last review'
                : 'Open a review from the workspace first'
          }
          aria-current={activeUrl ? 'page' : undefined}
        >
          <GitPullRequest size={19} />
        </button>
        <span className="rail-divider" aria-hidden="true" />
        <button
          onClick={onToggle}
          aria-expanded={repositoriesOpen}
          aria-controls={repositoriesOpen ? 'repository-list' : undefined}
          aria-label={repositoriesOpen ? 'Hide repositories' : 'Show repositories'}
          title={repositoriesOpen ? 'Hide repositories' : 'Show repositories'}
        >
          <Folders size={19} />
        </button>
        <button
          ref={repliesButton}
          aria-expanded={!!repliesPane}
          aria-controls={repliesPane ? 'review-replies' : undefined}
          title="Review alerts"
          aria-label={'Review alerts, ' + unread + ' unread'}
          onClick={openInbox}
        >
          <Bell size={19} />
          {unread > 0 && <span className="reply-count">{unread > 99 ? '99+' : unread}</span>}
        </button>
        <button
          title="Settings"
          aria-label="Settings"
          aria-expanded={settingsOpen}
          className="rail-settings"
          onClick={openSettings}
        >
          <Settings size={19} />
        </button>
      </nav>
      {repositoriesOpen && (
        <div id="repository-list" className="sidebar-contents">
          <div className="sidebar-title">
            <h2>Repositories</h2>
            <button aria-label="Add repository" title="Add repository" onClick={openAdd}>
              <Plus size={16} />
            </button>
          </div>
          {!repos.length && !adding && (
            <button className="add-first" onClick={openAdd}>
              <BookMarked size={15} /> Add your first repository
            </button>
          )}
          {repos.map((r) => (
            <section className="repo-group" key={r.name}>
              <div className="repo-group-name">
                <BookMarked size={14} />
                <strong title={r.name}>{r.name}</strong>
                <button
                  title="Compare pull requests"
                  aria-label={'Compare pull requests in ' + r.name}
                  onClick={() => setComparison(r.name)}
                >
                  <GitCompareArrows size={15} />
                </button>
                <button
                  title="Manage authors"
                  aria-label={'Manage authors for ' + r.name}
                  onClick={() => {
                    setError('');
                    setManage(r.name);
                  }}
                >
                  <MoreHorizontal size={15} />
                </button>
              </div>
              {!r.watching.length ? (
                <button className="choose-authors" onClick={() => setManage(r.name)}>
                  Choose authors
                </button>
              ) : (
                <>
                  <small>
                    {r.watching.length} monitored ·{' '}
                    {r.pulls.filter((p) => r.watching.includes(p.author)).length} open
                  </small>
                  {r.pulls
                    .filter((p) => r.watching.includes(p.author))
                    .map((p) => {
                      const pr = 'https://github.com/' + r.name + '/pull/' + p.number;
                      // An answer for this PR may be running while another PR is open.
                      const isNew = p.unseen && activeUrl !== pr;
                      const run = workingPrs.get(pr);
                      const working = run
                        ? run === 'summary'
                          ? 'Summarising'
                          : run === 'review'
                            ? 'Reviewing'
                            : 'Answering a question in'
                        : null;
                      return (
                        <div
                          key={p.number}
                          className="monitored-pr"
                          data-current={activeUrl === pr || undefined}
                          data-approved={p.approved || undefined}
                          data-new={isNew || undefined}
                          data-working={!!run || undefined}
                        >
                          <button
                            className="monitored-open"
                            aria-current={activeUrl === pr ? 'page' : undefined}
                            onClick={() => onOpen(pr)}
                          >
                            <span>
                              <GitPullRequest size={12} /> #{p.number} · {p.author}
                              {p.isDraft && ' · Draft'}
                            </span>
                            {isNew && <b className="monitored-new">New</b>}
                            {p.title}
                          </button>
                          <span className="monitored-actions">
                            {working ? (
                              <span
                                className="monitored-working"
                                role="status"
                                aria-label={working + ' pull request #' + p.number}
                                title={working + ' this PR. Open it to follow or cancel.'}
                              >
                                <LoaderCircle className="spin" size={14} aria-hidden />
                              </span>
                            ) : (
                              <>
                                <button
                                  aria-label={'Review pull request #' + p.number}
                                  title="Review this PR for findings"
                                  onClick={() => onReview(pr)}
                                >
                                  <ListChecks size={14} />
                                </button>
                                <button
                                  aria-label={'Summarise pull request #' + p.number}
                                  title="Summarise this PR"
                                  onClick={() => onSummarise(pr)}
                                >
                                  <Sparkles size={14} />
                                </button>
                              </>
                            )}
                            <button
                              aria-label={
                                (p.approved ? 'Approved. Review' : 'Approve') +
                                ' pull request #' +
                                p.number
                              }
                              title={
                                p.approved
                                  ? 'You approved this PR. Review it again'
                                  : 'Approve this PR. You confirm before it is sent'
                              }
                              onClick={() => onApprove(pr)}
                            >
                              <CircleCheck size={14} />
                            </button>
                          </span>
                        </div>
                      );
                    })}
                </>
              )}
              {r.error && <small role="status">Refresh failed · cached results</small>}
            </section>
          ))}
          {error && !manage && !adding && <p role="alert">{error}</p>}
        </div>
      )}
      {repositoriesOpen && (
        <div className="sidebar-foot">
          <span className="local-status">
            <HardDrive size={13} /> Local workspace
          </span>
        </div>
      )}
      {repliesPane}
      {comparison && (
        <CrossPrComparison key={comparison} repo={comparison} close={() => setComparison(null)} />
      )}
      {adding && (
        <WorkspaceDialog title="Add repository" busy={busy} onClose={() => setAdding(false)}>
          <p>Connect a GitHub repository, then choose whose pull requests to follow.</p>
          <form onSubmit={add} className="dialog-form">
            <label htmlFor="repo-add">Repository</label>
            <input
              id="repo-add"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="owner/repository or GitHub URL"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              required
            />
            {error && <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button disabled={busy || !name.trim()}>
                {busy ? 'Fetching authors…' : 'Add repository'}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
      {selected && (
        <WorkspaceDialog title={selected.name} onClose={() => setManage(null)}>
          <AuthorPicker
            key={selected.name}
            repo={selected}
            busy={busy}
            error={error}
            onWatch={(authors, done) =>
              update(() => window.reviewer.watchAuthors(selected.name, authors), done)
            }
            onRefresh={() => update(() => window.reviewer.syncRepository(selected.name, true))}
          />
          {(error || selected.error) && <p role="alert">{error || selected.error}</p>}
          <button
            className="remove-repo"
            disabled={busy}
            onClick={() =>
              update(
                () => window.reviewer.removeRepository(selected.name),
                () => setManage(null),
              )
            }
          >
            Remove repository
          </button>
        </WorkspaceDialog>
      )}
    </aside>
  );
}

function AuthorPicker({
  repo,
  busy,
  error,
  onWatch,
  onRefresh,
}: {
  repo: Repository;
  busy: boolean;
  error: string;
  onWatch: (authors: string[], done: () => void) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="authors-heading">
        <h3>Monitored authors</h3>
        <button disabled={busy} onClick={onRefresh}>
          Refresh authors
        </button>
      </div>
      <p>Open pull requests from selected authors appear in the sidebar.</p>
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button
          className="author-trigger"
          isDisabled={busy}
          aria-label={`Select authors, ${repo.watching.length} selected`}
        >
          {repo.watching.length ? `${repo.watching.length} selected` : 'Select authors'}
          <ChevronDown size={16} aria-hidden />
        </Button>
        <Popover className="author-popover" placement="bottom start" offset={4}>
          <Dialog className="author-menu" aria-label="Select authors">
            <AuthorOptions
              repo={repo}
              busy={busy}
              error={error}
              onSave={(authors) => onWatch(authors, () => setOpen(false))}
            />
          </Dialog>
        </Popover>
      </DialogTrigger>
      {repo.checked && <small>Last checked {new Date(repo.checked).toLocaleString()}</small>}
    </>
  );
}

function AuthorOptions({
  repo,
  busy,
  error,
  onSave,
}: {
  repo: Repository;
  busy: boolean;
  error: string;
  onSave: (authors: string[]) => void;
}) {
  const [selected, setSelected] = useState(() => new Set(repo.watching));
  const [filter, setFilter] = useState('');
  const query = filter.trim().replace(/^@/, '').toLowerCase();
  const authors = new Set([...repo.authors, ...repo.watching, ...selected]);
  const matches = [...authors].filter((author) => author.includes(query)).sort();
  const custom = login.safeParse(query);
  const addCustom = custom.success && !authors.has(custom.data);
  function toggle(author: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(author)) next.delete(author);
      else next.add(author);
      return next;
    });
  }
  return (
    <>
      <TextField
        className="author-search"
        type="search"
        aria-label="Search authors"
        autoFocus
        autoComplete="off"
        spellCheck="false"
        value={filter}
        onChange={setFilter}
      >
        <Search size={16} aria-hidden />
        <Input placeholder="Search or add a username" />
      </TextField>
      <div className="author-list" role="group" aria-label="Authors">
        {matches.map((author) => (
          <label key={author}>
            <input
              type="checkbox"
              disabled={busy}
              checked={selected.has(author)}
              onChange={() => toggle(author)}
            />
            {author}
          </label>
        ))}
        {matches.length === 0 && (
          <p role="status">
            {query ? 'No matching authors.' : 'No authors found. Enter a GitHub username.'}
          </p>
        )}
        {addCustom && (
          <button className="quiet" disabled={busy} onClick={() => toggle(custom.data)}>
            Monitor @{custom.data}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="author-menu-footer">
        <span aria-live="polite">{selected.size} selected</span>
        <button disabled={busy} onClick={() => onSave([...selected])}>
          {busy ? 'Saving…' : 'Apply selection'}
        </button>
      </div>
    </>
  );
}
