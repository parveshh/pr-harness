import {
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  File,
  Folder,
  MessageSquare,
  Search,
} from 'lucide-react';
import type { ReaderFile } from '../../shared/reader.js';
import { explorerWindowThreshold, shouldWindow } from '../../shared/windowing.js';
import { useRowWindow } from './useRowWindow.js';

export type TreeFile = { path: string; detail?: string } & Partial<
  Pick<ReaderFile, 'status' | 'needsReview' | 'reviewed'>
>;

const noRows: readonly number[] = [];
type FolderNode = { directories: Map<string, FolderNode>; files: TreeFile[] };
function folder(): FolderNode {
  return { directories: new Map(), files: [] };
}
// One visible line of the tree, for an explorer long enough to be windowed.
type TreeRow = { key: string; depth: number } & (
  | { kind: 'directory'; path: string; name: string; open: boolean }
  | { kind: 'file'; file: TreeFile }
);

export function ChangedFiles({
  files,
  selected,
  counts,
  choose,
  changedSinceCheckpoint,
  collapse,
  filterRef,
}: {
  files: TreeFile[];
  selected: string | undefined;
  counts: ReadonlyMap<string, number>;
  choose: (path: string) => void;
  changedSinceCheckpoint?: number | undefined;
  collapse: () => void;
  filterRef: RefObject<HTMLInputElement | null>;
}) {
  const [filter, setFilter] = useState('');
  const [closed, setClosed] = useState(new Set<string>());
  const query = filter.trim().toLowerCase();
  const [previousSelection, setPreviousSelection] = useState(selected);
  if (selected !== previousSelection) {
    setPreviousSelection(selected);
    if (selected) {
      if (!selected.toLowerCase().includes(query)) setFilter('');
      const ancestors = [...closed].filter((path) => selected.startsWith(path + '/'));
      if (ancestors.length)
        setClosed(new Set([...closed].filter((path) => !ancestors.includes(path))));
    }
  }
  const tree = useMemo(() => {
    const root = folder();
    for (const file of files) {
      if (!file.path.toLowerCase().includes(query)) continue;
      let node = root;
      for (const name of file.path.split('/').slice(0, -1)) {
        let child = node.directories.get(name);
        if (!child) {
          child = folder();
          node.directories.set(name, child);
        }
        node = child;
      }
      node.files.push(file);
    }
    return root;
  }, [files, query]);
  // A long list renders only the rows near the viewport, as one flat list. The choice follows
  // the whole file list, so filtering or collapsing a folder never swaps the markup under focus.
  const windowed = useMemo(() => {
    const directories = new Set<string>();
    for (const file of files)
      for (let at = file.path.indexOf('/'); at >= 0; at = file.path.indexOf('/', at + 1))
        directories.add(file.path.slice(0, at));
    return shouldWindow(files.length + directories.size, explorerWindowThreshold);
  }, [files]);
  const rows = useMemo(() => {
    if (!windowed) return null;
    const list: TreeRow[] = [];
    function walk(node: FolderNode, parent: string, depth: number) {
      for (const [name, child] of node.directories) {
        const path = parent + name;
        const open = !!query || !closed.has(path);
        list.push({ kind: 'directory', key: 'directory:' + path, depth, path, name, open });
        if (open) walk(child, path + '/', depth + 1);
      }
      for (const file of node.files)
        list.push({ kind: 'file', key: 'file:' + file.path, depth, file });
    }
    walk(tree, '', 0);
    return list;
  }, [windowed, tree, closed, query]);
  const scroll = useRef<HTMLDivElement>(null);
  const rowList = useRef<HTMLUListElement>(null);
  const { segments, reveal } = useRowWindow({
    enabled: !!rows,
    count: rows?.length ?? 0,
    scroller: scroll,
    list: rowList,
    pinned: noRows,
  });
  // Moving to another file, by a shortcut or Next unread, brings its row into view.
  const showSelected = useEffectEvent(() => {
    if (!selected) return;
    if (rows) reveal(rows.findIndex((row) => row.kind === 'file' && row.file.path === selected));
    else
      scroll.current
        ?.querySelector('.file-row[aria-current="true"]')
        ?.scrollIntoView({ block: 'nearest' });
  });
  useLayoutEffect(() => {
    showSelected();
  }, [selected]);
  function directoryRow(path: string, name: string, open: boolean) {
    return (
      <button
        className="directory-row"
        aria-expanded={open}
        disabled={!!query}
        title={path}
        onClick={() =>
          setClosed((previous) => {
            const next = new Set(previous);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          })
        }
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Folder size={15} />
        {name}
      </button>
    );
  }
  function fileRow(file: TreeFile) {
    const comments = counts.get(file.path) ?? 0;
    const label =
      file.path +
      ', ' +
      (file.detail ?? file.status ?? '') +
      (file.reviewed && !file.detail ? ', reviewed' : '') +
      (comments ? ', ' + comments + (comments === 1 ? ' comment' : ' comments') : '');
    return (
      <button
        className="file-row"
        aria-label={label}
        title={label}
        aria-current={file.path === selected ? 'true' : undefined}
        onClick={() => choose(file.path)}
      >
        <File size={14} />
        <span className="tree-entry">
          <span className="tree-name">{file.path.split('/').at(-1)}</span>
          {file.detail && <small>{file.detail}</small>}
        </span>
        {file.status && file.status !== 'modified' && (
          <span className={'change-tag ' + file.status}>
            {file.status.slice(0, 1).toUpperCase()}
          </span>
        )}
        {file.needsReview && <small>Needs another look</small>}
        {comments > 0 && (
          <span className="file-comments">
            <MessageSquare size={12} /> {comments}
          </span>
        )}
        {file.reviewed && <CheckCircle2 size={14} className="plus" />}
      </button>
    );
  }
  function renderFolder(node: FolderNode, parent: string): ReactNode {
    return (
      <ul>
        {Array.from(node.directories, ([name, child]) => {
          const path = parent + name;
          const open = !!query || !closed.has(path);
          return (
            <li key={path}>
              {directoryRow(path, name, open)}
              {open && renderFolder(child, path + '/')}
            </li>
          );
        })}
        {node.files.map((file) => (
          <li key={file.path}>{fileRow(file)}</li>
        ))}
      </ul>
    );
  }
  const reviewed = files.filter((file) => file.reviewed).length;
  const title = changedSinceCheckpoint === undefined ? 'Changed files' : 'Re-review queue';
  return (
    <nav aria-label={title} className="changed-tree">
      <div className="nav-heading">
        <div className="pane-title">
          <h2>{title}</h2>
          <button
            className="pane-toggle"
            title="Collapse file tree"
            aria-label="Collapse file tree"
            onClick={collapse}
          >
            <ChevronLeft size={17} />
          </button>
        </div>
        {changedSinceCheckpoint === undefined ? (
          <>
            <span>
              {reviewed} of {files.length} reviewed
            </span>
            <progress
              aria-label="Files reviewed"
              value={reviewed}
              max={Math.max(1, files.length)}
            />
          </>
        ) : (
          <span>{changedSinceCheckpoint} changed since checkpoint</span>
        )}
        <label className="file-filter">
          <Search size={14} />
          <input
            ref={filterRef}
            type="search"
            aria-label="Filter files"
            placeholder="Filter files…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
      </div>
      <div className="files-scroll" ref={scroll}>
        {rows && segments ? (
          <ul ref={rowList} className="tree-window" aria-label={rows.length + ' files and folders'}>
            {segments.map((segment) => {
              if (segment.kind === 'gap')
                return (
                  <li
                    key={segment.key}
                    role="presentation"
                    aria-hidden="true"
                    style={{ height: segment.height }}
                  />
                );
              const row = rows[segment.index];
              if (!row) return null;
              return (
                <li
                  key={row.key}
                  aria-level={row.depth + 1}
                  aria-setsize={rows.length}
                  aria-posinset={segment.index + 1}
                  data-row={segment.index}
                  data-plain={row.kind === 'file' && !row.file.detail ? '' : undefined}
                  style={{ paddingLeft: row.depth * 10 }}
                >
                  {row.kind === 'file'
                    ? fileRow(row.file)
                    : directoryRow(row.path, row.name, row.open)}
                </li>
              );
            })}
          </ul>
        ) : (
          renderFolder(tree, '')
        )}
        {query && !tree.files.length && !tree.directories.size && <p>No matching files.</p>}
      </div>
    </nav>
  );
}
