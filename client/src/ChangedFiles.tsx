import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  MessageSquare,
  Search,
} from 'lucide-react';
import { Button, DialogTrigger, Dialog, Popover } from 'react-aria-components';
import type { ReaderFile } from '../../shared/reader.js';

export type TreeFile = { path: string; detail?: string } & Partial<
  Pick<ReaderFile, 'status' | 'needsReview' | 'reviewed'>
>;

type FolderNode = { directories: Map<string, FolderNode>; files: TreeFile[] };
function folder(): FolderNode {
  return { directories: new Map(), files: [] };
}

export function FilePicker({
  files,
  selected,
  counts,
  choose,
  changedSinceCheckpoint,
}: {
  files: TreeFile[];
  selected: string | undefined;
  counts: ReadonlyMap<string, number>;
  choose: (path: string) => void;
  changedSinceCheckpoint?: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const title = changedSinceCheckpoint === undefined ? 'Changed files' : 'Re-review queue';
  const index = files.findIndex((file) => file.path === selected);
  return (
    <div className="file-picker">
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button className="file-picker-trigger" aria-label={'Choose file, ' + (selected ?? title)}>
          <File size={16} />
          <span>{selected ?? title}</span>
          <ChevronDown size={15} />
        </Button>
        <Popover className="file-popover" placement="bottom start">
          <Dialog aria-label={title}>
            <FileTree
              files={files}
              selected={selected}
              counts={counts}
              changedSinceCheckpoint={changedSinceCheckpoint}
              choose={(path) => {
                choose(path);
                setOpen(false);
              }}
            />
          </Dialog>
        </Popover>
      </DialogTrigger>
      {index >= 0 && (
        <small>
          {index + 1} of {files.length} files
        </small>
      )}
    </div>
  );
}

function FileTree({
  files,
  selected,
  counts,
  choose,
  changedSinceCheckpoint,
}: Parameters<typeof FilePicker>[0]) {
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
  function renderFolder(node: FolderNode, parent: string) {
    return (
      <ul>
        {Array.from(node.directories, ([name, child]) => {
          const path = parent + name;
          const open = !!query || !closed.has(path);
          return (
            <li key={path}>
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
              {open && renderFolder(child, path + '/')}
            </li>
          );
        })}
        {node.files.map((file) => {
          const comments = counts.get(file.path) ?? 0;
          const label =
            file.path +
            ', ' +
            (file.detail ?? file.status ?? '') +
            (file.reviewed && !file.detail ? ', reviewed' : '') +
            (comments ? ', ' + comments + (comments === 1 ? ' comment' : ' comments') : '');
          return (
            <li key={file.path}>
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
            </li>
          );
        })}
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
            autoFocus
            type="search"
            aria-label="Filter files"
            placeholder="Filter files…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
      </div>
      <div className="files-scroll">
        {renderFolder(tree, '')}
        {query && !tree.files.length && !tree.directories.size && <p>No matching files.</p>}
      </div>
    </nav>
  );
}
