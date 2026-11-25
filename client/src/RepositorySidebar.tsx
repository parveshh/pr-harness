import { CrossPrComparison } from './CrossPrComparison.js';
import {
  useEffect,
  useId,
  useState,
  type Dispatch,
  type SetStateAction,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button, Dialog, DialogTrigger, Input, Popover, TextField } from 'react-aria-components';
import { login, readableError, repoName, type Repository } from '../../shared/assistant.js';

import {
  Folder,
  Inbox,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Search,
  GitCompareArrows,
  MoreHorizontal,
  Plus,
  Bell,
  Settings,
  GitCommitHorizontal,
  CircleDashedCheck,
  CircleCheck,
  CircleAlert,
  UserRoundCheck,
} from 'lucide-react';
import type { ApprovalStage, SavedReview } from '../../shared/reviews.js';
import { CommitLink, DraftLabel, PrNumberLink, formatPrDate } from './components/PrMetadata.js';
import type { RepositoryGroup } from '../../shared/repository-groups.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';

export function RepositorySidebar({
  layoutPicker,
  repos,
  setRepos,
  groups,
  openSaved,
  openMonitored,
  selectedRepo,
  chooseRepository,
  requestCount,
  newRequests,
  requestsSelected,
  chooseRequests,
  refresh,
  refreshSavedStatuses,
  activeUrl,
  openInbox,
  openSettings,
  repliesButton,
  repliesPane,
  unread,
}: {
  layoutPicker: ReactNode;
  repos: Repository[];
  setRepos: Dispatch<SetStateAction<Repository[] | null>>;
  groups: RepositoryGroup[];
  openSaved: (url: string) => void;
  openMonitored: (url: string) => void;
  selectedRepo: string | null;
  chooseRepository: (name: string) => void;
  // Null until a list of review requests is available.
  requestCount: number | null;
  newRequests: number;
  requestsSelected: boolean;
  chooseRequests: () => void;
  refresh: number;
  refreshSavedStatuses: () => void;
  activeUrl: string | null;
  openInbox: () => void;
  openSettings: () => void;
  repliesButton: RefObject<HTMLButtonElement | null>;
  repliesPane: ReactNode;
  unread: number;
}) {
  const [adding, setAdding] = useState(false),
    [name, setName] = useState(''),
    [comparison, setComparison] = useState<string | null>(null),
    [manage, setManage] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [showRepositories, setShowRepositories] = useState(true);
  const [lastActive, setLastActive] = useState(activeUrl);
  if (activeUrl !== lastActive) {
    setLastActive(activeUrl);
    if (activeUrl) setShowRepositories(true);
  }
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
        if (alive) {
          setRepos((current) => current ?? []);
          setError('Could not load repositories. ' + readableError(e));
        }
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
  }, [refresh, setRepos]);
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
  }, [activeUrl, setRepos]);
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
        setShowRepositories(true);
        chooseRepository(parsed.data);
        setManage(parsed.data);
      },
    );
  }
  return (
    <aside className="repo-sidebar repository-navigation" aria-label="Repository sidebar">
      <nav className="workspace-rail" aria-label="Workspace tools">
        {layoutPicker}
        <button
          ref={repliesButton}
          title="Review alerts"
          aria-label={'Review alerts, ' + unread + ' unread'}
          aria-expanded={!!repliesPane}
          aria-controls={repliesPane ? 'review-replies' : undefined}
          onClick={openInbox}
        >
          <Bell size={18} aria-hidden="true" />
          {unread > 0 && (
            <span className="reply-count" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
        <button
          aria-label="Settings"
          title="Settings"
          aria-haspopup="dialog"
          onClick={openSettings}
        >
          <Settings size={18} aria-hidden="true" />
        </button>
      </nav>
      <div className="sidebar-contents" hidden={!!repliesPane}>
        <div
          className="repository-row review-requests-row"
          data-selected={requestsSelected || undefined}
        >
          <Inbox size={16} className="requests-icon" aria-hidden="true" />
          <button
            className="repo-link"
            aria-label={
              'Review requests' +
              (requestCount === null ? '' : ', ' + requestCount + ' open') +
              (newRequests > 0 ? ', ' + newRequests + ' new' : '')
            }
            aria-current={requestsSelected ? 'page' : undefined}
            onClick={chooseRequests}
          >
            <span>Review requests</span>
          </button>
          {requestCount !== null && (
            <span
              className="request-count"
              data-new={newRequests > 0 || undefined}
              aria-hidden="true"
            >
              {requestCount}
            </span>
          )}
        </div>
        <nav aria-label="Repositories">
          <div className="sidebar-title">
            <h2>
              <button
                className="repositories-disclosure"
                aria-expanded={showRepositories}
                aria-controls="repository-folders"
                onClick={() => setShowRepositories(!showRepositories)}
              >
                Repositories{' '}
                {showRepositories ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            </h2>
            <button aria-label="Add repository" title="Add repository" onClick={openAdd}>
              <Plus size={16} />
            </button>
          </div>
          <div id="repository-folders" hidden={!showRepositories}>
            {groups.map((group) => (
              <RepositoryFolder
                key={group.key}
                group={group}
                activeUrl={selectedRepo === group.key ? activeUrl : null}
                currentQueue={!activeUrl && selectedRepo === group.key && !repliesPane}
                choose={() => chooseRepository(group.key)}
                manage={() => {
                  setError('');
                  setManage(group.key);
                }}
                openSaved={openSaved}
                openMonitored={openMonitored}
                onError={setError}
              />
            ))}
          </div>
        </nav>
        {error && !manage && !adding && <p role="alert">{error}</p>}
      </div>
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
          <button
            className="quiet"
            onClick={() => {
              setComparison(selected.name);
              setManage(null);
            }}
          >
            <GitCompareArrows size={15} /> Compare pull requests
          </button>
          <AuthorPicker
            key={selected.name}
            repo={selected}
            busy={busy}
            error={error}
            onWatch={(authors, done) =>
              update(() => window.reviewer.watchAuthors(selected.name, authors), done)
            }
            onRefresh={() => {
              refreshSavedStatuses();
              update(() => window.reviewer.syncRepository(selected.name, true));
            }}
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

const approvalIcons = {
  partial: { icon: CircleDashedCheck, label: 'Partially approved · further review required' },
  approved: { icon: CircleCheck, label: 'Approved on GitHub' },
  'approval-recorded': { icon: UserRoundCheck, label: 'Reviewer approval recorded' },
  mixed: { icon: CircleAlert, label: 'Reviewer approval recorded · changes requested' },
  'changes-requested': { icon: CircleAlert, label: 'Changes requested' },
} satisfies Record<Exclude<ApprovalStage, 'none'>, { icon: typeof CircleCheck; label: string }>;

function sidebarStatus({
  head,
  commitCount,
  approvalStage,
}: Pick<SavedReview, 'head' | 'commitCount' | 'approvalStage'>) {
  const commits =
    commitCount === undefined ? '' : commitCount + (commitCount === 1 ? ' commit' : ' commits');
  const badge =
    approvalStage && approvalStage !== 'none' ? approvalIcons[approvalStage] : undefined;
  const commitLabel = [commits, head].filter(Boolean).join(' · ');
  return { head, commits, commitLabel, badge, approvalStage };
}

function RepositoryFolder({
  group,
  currentQueue,
  activeUrl,
  choose,
  manage,
  openSaved,
  openMonitored,
  onError,
}: {
  onError: (message: string) => void;
  group: RepositoryGroup;
  currentQueue: boolean;
  activeUrl: string | null;
  choose: () => void;
  manage: () => void;
  openSaved: (url: string) => void;
  openMonitored: (url: string) => void;
}) {
  const listId = useId();
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [lastActive, setLastActive] = useState(activeUrl);
  if (activeUrl !== lastActive) {
    setLastActive(activeUrl);
    if (activeUrl) setExpanded(true);
  }
  const rows = [
    ...group.pulls.map(({ url, pull }) => ({
      url,
      label: pull.title,
      status: sidebarStatus(pull),
      detail: '#' + pull.number + ' ' + pull.title,
      author: pull.author,
      isDraft: pull.isDraft,
      date: pull.openedAt && 'Opened ' + formatPrDate(pull.openedAt),
      open: openMonitored,
    })),
    ...group.saved.map((review) => {
      const { url, local, title, author, isDraft, savedAt, openedAt } = review;
      const number = url.split('/').at(-1);
      const label = local
        ? (local.branch ?? 'Detached HEAD') + ' → ' + local.baseBranch
        : title || 'Pull request';
      return {
        url,
        label,
        status: sidebarStatus(review),
        detail: local ? label : title ? '#' + number + ' ' + title : 'Pull request #' + number,
        author: local ? undefined : author,
        isDraft: !local && isDraft,
        date: local
          ? undefined
          : openedAt
            ? 'Opened ' + formatPrDate(openedAt)
            : 'Saved ' + formatPrDate(savedAt),
        open: openSaved,
      };
    }),
  ];
  const limit = 5;
  const visible = showAll ? rows : rows.slice(0, limit);
  if (!showAll && activeUrl && !visible.some((row) => row.url === activeUrl)) {
    const active = rows.find((row) => row.url === activeUrl);
    if (active) visible[limit - 1] = active;
  }
  const Arrow = expanded ? ChevronDown : ChevronRight;
  const FolderIcon = expanded && rows.length ? FolderOpen : Folder;
  return (
    <div className="repository-folder">
      <div className="repository-row" data-selected={currentQueue || undefined}>
        {rows.length > 0 ? (
          <button
            className="folder-disclosure"
            aria-label={(expanded ? 'Collapse ' : 'Expand ') + group.key}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded(!expanded)}
          >
            <FolderIcon className="folder-icon" size={16} />
            <Arrow className="folder-arrow" size={16} />
          </button>
        ) : (
          <Folder size={16} className="empty-folder-icon" />
        )}
        <button
          className="repo-link"
          title={group.key}
          aria-label={group.key}
          aria-current={currentQueue ? 'page' : undefined}
          onClick={() => {
            setExpanded(true);
            choose();
          }}
        >
          <span>{group.label}</span>
        </button>
        {group.monitored && (
          <button
            className="repo-options"
            title="Manage authors"
            aria-label={'Manage authors for ' + group.key}
            onClick={manage}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <ul
          id={listId}
          className="sidebar-reviews"
          aria-label={'Reviews in ' + group.key}
          hidden={!expanded}
        >
          {visible.map(({ url, label, detail, author, isDraft, date, status, open }) => {
            const description = [
              author && '@' + author,
              isDraft && 'Draft',
              date,
              status.commitLabel,
              status.badge?.label,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={url} className="sidebar-review-row">
                <button
                  className="sidebar-review"
                  title={description ? label + '\n' + description : detail}
                  aria-description={description || undefined}
                  aria-label={detail}
                  aria-current={url === activeUrl ? 'page' : undefined}
                  onClick={() => open(url)}
                >
                  <span className="sidebar-review-heading">
                    <span className="sidebar-review-title">{label}</span>
                    {status.badge && (
                      <span
                        className="approval-stage"
                        data-stage={status.approvalStage}
                        title={status.badge.label}
                      >
                        <status.badge.icon size={15} aria-hidden="true" />
                      </span>
                    )}
                  </span>
                </button>
                {(date || author || isDraft) && (
                  <small className="sidebar-review-meta">
                    <PrNumberLink url={url} onError={onError} />
                    {author && ' · @' + author}
                    {isDraft && (
                      <>
                        {' '}
                        · <DraftLabel />
                      </>
                    )}
                    {date && ' · ' + date}
                  </small>
                )}
                {status.commitLabel && (
                  <small className="sidebar-review-commit" title={status.commitLabel}>
                    <GitCommitHorizontal size={13} aria-hidden="true" />
                    {status.commits}
                    {status.head && <CommitLink url={url} head={status.head} onError={onError} />}
                  </small>
                )}
              </li>
            );
          })}
          {rows.length > limit && (
            <li>
              <button
                className="sidebar-show-more"
                aria-expanded={showAll}
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? 'Show less' : 'Show more'}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
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
      <p>Open pull requests from selected authors appear in the repository’s pull request list.</p>
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
