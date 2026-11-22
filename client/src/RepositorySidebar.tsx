import { CrossPrComparison } from './CrossPrComparison.js';
import { useEffect, useState, type FormEvent } from 'react';
import { login, readableError, repoName, type Repository } from '../../shared/assistant.js';

import {
  BookMarked,
  GitPullRequest,
  GitCompareArrows,
  Layers2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  HardDrive,
  Bell,
  Settings,
  Sparkles,
  CircleCheck,
  LoaderCircle,
} from 'lucide-react';
import { useWorkingPrs } from './chatRuns.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';

export function RepositorySidebar({
  onOpen,
  onSummarise,
  onApprove,
  refresh,
  onHome,
  activeUrl,
  collapsed,
  onToggle,
  openInbox,
  openSettings,
  unread,
}: {
  onOpen: (url: string) => void;
  onSummarise: (url: string) => void;
  onApprove: (url: string) => void;
  // Changes when the PR list should be read from GitHub again, such as after a review.
  refresh: number;
  onHome: () => void;
  activeUrl: string | null;
  collapsed: boolean;
  onToggle: () => void;
  openInbox: () => void;
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
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Show repositories' : 'Hide repositories'}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        <button
          title="Review replies"
          aria-label={'Review replies, ' + unread + ' unread'}
          onClick={openInbox}
        >
          <Bell size={19} />
          {unread > 0 && <span className="reply-count">{unread > 99 ? '99+' : unread}</span>}
        </button>
        <button
          title="Settings"
          aria-label="Settings"
          className="rail-settings"
          onClick={openSettings}
        >
          <Settings size={19} />
        </button>
      </nav>
      {!collapsed && (
        <div className="sidebar-contents">
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
                              <button
                                aria-label={'Summarise pull request #' + p.number}
                                title="Summarise this PR"
                                onClick={() => onSummarise(pr)}
                              >
                                <Sparkles size={14} />
                              </button>
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
      {!collapsed && (
        <div className="sidebar-foot">
          <span className="local-status">
            <HardDrive size={13} /> Local workspace
          </span>
        </div>
      )}
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
            onWatch={(authors) => {
              const previous = selected.watching;
              const show = (watching: string[]) =>
                setRepos((rows) =>
                  rows.map((row) => (row.name === selected.name ? { ...row, watching } : row)),
                );
              show(authors);
              update(() =>
                window.reviewer.watchAuthors(selected.name, authors).catch((error: unknown) => {
                  show(previous);
                  throw error;
                }),
              );
            }}
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
  onWatch,
  onRefresh,
}: {
  repo: Repository;
  busy: boolean;
  onWatch: (authors: string[]) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState('');
  const names = [...new Set([...repo.watching, ...repo.authors])]
    .sort()
    .filter((a) => a.includes(filter.trim().toLowerCase()));
  const custom = login.safeParse(filter.replace(/^@/, ''));
  return (
    <>
      <div className="authors-heading">
        <h3>Monitored authors</h3>
        <button disabled={busy} onClick={onRefresh}>
          Refresh authors
        </button>
      </div>
      <p>Open pull requests from selected authors appear in the sidebar.</p>
      <label htmlFor="author-filter">Find or add a GitHub username</label>
      <input
        id="author-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search authors"
      />
      <div className="author-list">
        {names.map((author) => (
          <label key={author}>
            <input
              type="checkbox"
              disabled={busy}
              checked={repo.watching.includes(author)}
              onChange={(e) =>
                onWatch(
                  e.target.checked
                    ? [...repo.watching, author]
                    : repo.watching.filter((a) => a !== author),
                )
              }
            />
            {author}
          </label>
        ))}
      </div>
      {custom.success && !names.includes(custom.data) && (
        <button disabled={busy} onClick={() => onWatch([...repo.watching, custom.data])}>
          Monitor @{custom.data}
        </button>
      )}
      {repo.checked && <small>Last checked {new Date(repo.checked).toLocaleString()}</small>}
    </>
  );
}
