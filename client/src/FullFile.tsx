import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { diffLines } from '../../shared/diff.js';
import { highlightRows, languageFor } from '../../shared/highlight.js';
import { CodeLine } from './components/CodeLine.js';
import { readableError, type CitedSourceKey } from '../../shared/assistant.js';

// Each page starts with enough line information to render it independently.
export type FileFocus = { side: 'old' | 'new'; line: number };
function pages(text: string, focus: FileFocus | null) {
  const result: { start: number; old: number; next: number }[] = [];
  let initial = 0;
  let old = 1,
    next = 1,
    count = 0;
  for (let at = 0; at < text.length;) {
    const end = text.indexOf('\n', at);
    const marker = text[at];
    if (marker === '@') {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(
        text.slice(at, end < 0 ? undefined : end),
      );
      if (header) {
        old = Number(header[1]);
        next = Number(header[2]);
      }
    } else {
      if (count++ % 400 === 0) result.push({ start: at, old, next });
      if (
        ((focus?.side === 'new' && marker !== '-' && next === focus.line) ||
          (focus?.side === 'old' && marker !== '+' && old === focus.line)) &&
        marker !== '\\'
      )
        initial = result.length - 1;
      if (marker !== '+' && marker !== '\\') old++;
      if (marker !== '-' && marker !== '\\') next++;
    }
    at = end < 0 ? text.length : end + 1;
  }
  return { offsets: result, initial };
}
export function FullFile({
  url,
  path,
  target,
  discussions,
  codeLessons,
  focus,
}: {
  url: string;
  path: string;
  target: string | Pick<CitedSourceKey, 'run' | 'id'>;
  focus: FileFocus | null;
  codeLessons?: (lines: string[]) => ReactNode;
  discussions?: (old: number | null, current: number | null) => ReactNode;
}) {
  const [text, setText] = useState<string | null>(null),
    [error, setError] = useState(''),
    [chosen, setPage] = useState<number | null>(null),
    [retry, setRetry] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const snapshot = typeof target !== 'string';
  useEffect(() => {
    let current = true;
    const request =
      typeof target === 'string'
        ? window.reviewer.fullFile({ url, revision: target, path })
        : window.reviewer.citedSource({ url, run: target.run, id: target.id }).then((source) =>
            // Present a single immutable snapshot as context lines in the paged code reader.
            source ? ' ' + source.replace(/\n$/, '').replaceAll('\n', '\n ') : '',
          );
    request
      .then((value) => {
        if (current) setText(value);
      })
      .catch((e: unknown) => {
        if (current) setError(readableError(e));
      });
    return () => {
      current = false;
    };
  }, [url, target, path, retry]);
  const { offsets, initial } = useMemo(() => pages(text ?? '', focus), [text, focus]);
  const page = chosen ?? initial;
  useLayoutEffect(() => {
    if (text && focus && chosen === null)
      scroller.current
        ?.querySelector('[data-' + focus.side + '-line="' + focus.line + '"]')
        ?.scrollIntoView({ block: 'nearest' });
  }, [text, focus, chosen]);
  const lines = useMemo(() => {
    const start = offsets[page];
    if (!text || !start) return [];
    const body = text.slice(start.start, offsets[page + 1]?.start).replace(/\n$/, '');
    return diffLines('@@ -' + start.old + ' +' + start.next + ' @@\n' + body).lines;
  }, [offsets, page, text]);
  const syntax = useMemo(() => highlightRows(lines, languageFor(path)), [lines, path]);
  const reminders = useMemo(
    () => codeLessons?.(lines.map((line) => line.text)),
    [codeLessons, lines],
  );
  if (error)
    return (
      <p className="patch-note" role="alert">
        {error}{' '}
        <button
          onClick={() => {
            setError('');
            setRetry((n) => n + 1);
          }}
        >
          Retry full file
        </button>
      </p>
    );
  if (text === null)
    return (
      <p className="patch-note" role="status">
        Loading the full file at this revision…
      </p>
    );
  if (!lines.length) return <p className="patch-note">This file is empty.</p>;
  function go(index: number) {
    setPage(index);
    if (scroller.current) scroller.current.scrollTop = 0;
  }
  return (
    <>
      {offsets.length > 1 && (
        <div className="hunk-nav">
          <span>
            Page {page + 1} of {offsets.length}
          </span>
          <button disabled={!page} onClick={() => go(page - 1)}>
            Previous page
          </button>
          <button disabled={page + 1 >= offsets.length} onClick={() => go(page + 1)}>
            Next page
          </button>
        </div>
      )}
      {reminders}
      <div
        ref={scroller}
        className="diff-scroll"
        role="region"
        aria-label={snapshot ? 'Cited source' : 'Full file with changes'}
        tabIndex={0}
      >
        <div className="diff-content">
          {lines.map((line, i) => (
            <Fragment key={i}>
              <div
                className={'diff-line ' + line.kind}
                data-selected={snapshot && line.newLine === focus?.line ? true : undefined}
                data-old-line={line.oldLine ?? undefined}
                data-new-line={line.newLine ?? undefined}
              >
                <span className="comment-gutter" />
                {!snapshot && <span className="gutter">{line.oldLine}</span>}
                <span className="gutter">{line.newLine}</span>
                <CodeLine text={line.text} tokens={syntax[i] ?? null} />
              </div>
              {discussions?.(line.oldLine, line.newLine)}
            </Fragment>
          ))}
        </div>
      </div>
    </>
  );
}
