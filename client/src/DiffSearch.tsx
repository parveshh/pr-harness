import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { readableError } from '../../shared/assistant.js';
import {
  searchBatchSize,
  type MatchingHunk,
  type SearchFilter,
  type SearchHit,
} from '../../shared/diff-search.js';
import type { ReaderView } from '../../shared/reader.js';

type Results = { hunks: MatchingHunk[]; total: number; index: number };

export function DiffSearch({
  url,
  view,
  generation,
  jump,
  close,
}: {
  url: string;
  view: ReaderView;
  generation: number;
  jump: (hit: SearchHit | null) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SearchFilter>('both');
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [lastGeneration, setLastGeneration] = useState(generation);
  if (lastGeneration !== generation) {
    setLastGeneration(generation);
    setResults(null);
    setError('');
  }
  const revision = view.revision;
  const partial =
    view.files.length < view.meta.totalFiles ||
    view.files.some((file) => file.kind === 'partial' || file.kind === 'unavailable');

  function show(hunks: MatchingHunk[], total: number, index: number) {
    setResults({ hunks, total, index });
    if (index < 0) {
      jump(null);
      return;
    }
    let occurrence = index;
    for (const hunk of hunks) {
      if (occurrence < hunk.count) {
        jump({ path: hunk.path, hunk: hunk.hunk, occurrence, query, filter });
        return;
      }
      occurrence -= hunk.count;
    }
    jump(null);
  }

  // Checkpoints change as the reader scrolls. Only a refreshed snapshot changes its patches.
  const searchablePaths = useEffectEvent(() =>
    view.files
      .filter((file) => file.kind === 'text' || file.kind === 'partial')
      .map((file) => file.path),
  );
  const lastScan = useRef({ revision, query, filter });
  const finish = useEffectEvent((hunks: MatchingHunk[], keepFile: boolean) => {
    let index = 0;
    if (keepFile) {
      // A refresh can remove a match or introduce an earlier one in a different file.
      // Only explicit search navigation should take the reader away from the open file.
      const currentHunk = view.files.find((f) => f.path === view.selected)?.hunk;
      const match =
        hunks.find((h) => h.path === view.selected && h.hunk === currentHunk) ??
        hunks.find((h) => h.path === view.selected);
      index = match ? hunks.slice(0, hunks.indexOf(match)).reduce((n, h) => n + h.count, 0) : -1;
    }
    show(
      hunks,
      hunks.reduce((n, h) => n + h.count, 0),
      index,
    );
  });
  useEffect(() => {
    if (!query) return;
    const previous = lastScan.current;
    const keepFile =
      previous.revision !== revision && previous.query === query && previous.filter === filter;
    lastScan.current = { revision, query, filter };
    let live = true;
    async function search() {
      const paths = searchablePaths();
      const hunks: MatchingHunk[] = [];
      for (let offset = 0; offset < paths.length; offset += searchBatchSize) {
        const batch = await window.reviewer.searchDiff({
          url,
          revision,
          paths: paths.slice(offset, offset + searchBatchSize),
          query,
          filter,
        });
        if (!live) return;
        for (const hunk of batch) hunks.push(hunk);
      }
      if (live) finish(hunks, keepFile);
    }
    const timer = window.setTimeout(() => {
      search().catch((cause: unknown) => {
        if (live) setError(readableError(cause));
      });
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [url, revision, generation, query, filter, attempt]);

  function reset() {
    setResults(null);
    setError('');
    jump(null);
  }
  function step(by: number) {
    if (results?.total) {
      const from = results.index < 0 && by < 0 ? 0 : results.index;
      show(results.hunks, results.total, (from + by + results.total) % results.total);
    }
  }

  const navigateFromDiff = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.key !== 'F3' ||
      !(event.target instanceof HTMLElement) ||
      (event.target !== document.body && !event.target.closest('.review-center')) ||
      event.target.closest('textarea, input, select, [contenteditable="true"]') ||
      document.querySelector('[role="dialog"], dialog[open]')
    )
      return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  });
  useEffect(() => {
    window.addEventListener('keydown', navigateFromDiff);
    return () => window.removeEventListener('keydown', navigateFromDiff);
  }, []);

  return (
    <div
      className="diff-search"
      role="search"
      aria-label="Search review diff"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        } else if (
          event.key === 'F3' ||
          (event.target === input.current && event.key === 'Enter')
        ) {
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <input
        autoFocus
        ref={input}
        type="search"
        aria-label="Search changed lines"
        placeholder="Search changed lines…"
        maxLength={1024}
        value={query}
        onChange={(event) => {
          reset();
          setQuery(event.target.value);
        }}
      />
      <select
        aria-label="Lines to search"
        value={filter}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'both' || value === 'added' || value === 'removed') {
            reset();
            setFilter(value);
          }
        }}
      >
        <option value="both">Added and removed</option>
        <option value="added">Added lines</option>
        <option value="removed">Removed lines</option>
      </select>
      <span role="status">
        {error || !query
          ? ''
          : !results
            ? 'Searching…'
            : results.total
              ? results.index < 0
                ? results.total === 1
                  ? '1 match'
                  : results.total + ' matches'
                : results.index + 1 + ' of ' + results.total
              : 'No matches'}
      </span>
      <button
        className="secondary"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!results?.total}
        onClick={() => step(-1)}
      >
        <ChevronUp size={15} />
      </button>
      <button
        className="secondary"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!results?.total}
        onClick={() => step(1)}
      >
        <ChevronDown size={15} />
      </button>
      <button
        className="secondary"
        aria-label="Close diff search"
        title="Close search (Escape)"
        onClick={close}
      >
        <X size={15} />
      </button>
      <small>Enter / F3 next · Shift for previous</small>
      {partial && <small>Some changes have no complete saved diff.</small>}
      {error && (
        <span role="alert">
          {error}{' '}
          <button
            onClick={() => {
              reset();
              setAttempt((n) => n + 1);
            }}
          >
            Retry search
          </button>
        </span>
      )}
    </div>
  );
}
