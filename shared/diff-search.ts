import { z } from 'zod';
import { reviewKey } from './reviews.js';

// Read a bounded number of patches per IPC request so a new query can interrupt a scan.
export const searchBatchSize = 8;
const filter = z.enum(['both', 'added', 'removed']);
export const diffSearchRequest = z.object({
  url: reviewKey,
  revision: z.string(),
  paths: z.array(z.string()).min(1).max(searchBatchSize),
  query: z.string().min(1).max(1024),
  filter,
});
export const matchingHunks = z.array(
  z.object({
    path: z.string(),
    hunk: z.number().int().nonnegative(),
    count: z.number().int().positive(),
  }),
);
export type SearchFilter = z.infer<typeof filter>;
export type SearchRequest = z.infer<typeof diffSearchRequest>;
export type MatchingHunk = z.infer<typeof matchingHunks>[number];
export type SearchHit = Pick<MatchingHunk, 'path' | 'hunk'> & {
  query: string;
  filter: SearchFilter;
  occurrence: number;
};

export function literalPattern(query: string) {
  if (!query) throw Error('Enter text to search for.');
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

export type MatchSpan = { row: number; start: number; end: number };

// Both the database scan and the on-screen occurrence lookup may encounter generated files.
export function searchTimeSlice(yieldTask: () => Promise<void>, signal?: AbortSignal) {
  let deadline = Date.now() + 8;
  return () => {
    signal?.throwIfAborted();
    if (Date.now() < deadline) return;
    return yieldTask().then(() => {
      signal?.throwIfAborted();
      deadline = Date.now() + 8;
    });
  };
}

// Count non-overlapping occurrences or stop at the requested occurrence. The offsets
// include the diff marker, which is displayed but excluded from matching.
export async function scanHunk(
  text: string,
  pattern: RegExp,
  filter: SearchFilter,
  pause: () => Promise<void> | undefined,
  occurrence?: number,
) {
  let count = 0;
  const rows = text.split('\n');
  let operations = 0;
  for (let i = 1; i < rows.length; i++) {
    if (operations++ % 1024 === 0) {
      const task = pause();
      if (task) await task;
    }
    const content = rows[i] ?? '';
    if (content[0] !== '+' && content[0] !== '-') continue;
    if (content[0] === '+' ? filter === 'removed' : filter === 'added') continue;
    pattern.lastIndex = 1;
    for (;;) {
      if (count === occurrence) {
        const found = pattern.exec(content);
        if (!found) break;
        return { count, match: { row: i - 1, start: found.index, end: pattern.lastIndex } };
      }
      if (!pattern.test(content)) break;
      count++;
      if (operations++ % 1024 === 0) {
        const task = pause();
        if (task) await task;
      }
    }
  }
  return { count, match: null };
}
