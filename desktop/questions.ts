import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  fileInfo,
  metadata,
  splitHunks,
  type FileInfo,
  type ReviewMeta,
} from '../shared/reader.js';
import {
  hunkLocation,
  pinnedQuestion,
  type PinnedQuestion,
  type PinQuestion,
  type QuestionKey,
} from '../shared/questions.js';

export const questionMigration = `
CREATE TABLE pinned_questions (
  id TEXT PRIMARY KEY, url TEXT NOT NULL REFERENCES snapshots(url), question TEXT NOT NULL,
  addressed INTEGER NOT NULL DEFAULT 0 CHECK(addressed IN (0,1)),
  origin TEXT NOT NULL, last_match TEXT NOT NULL, status TEXT NOT NULL, file_path TEXT
) STRICT;
CREATE INDEX questions_pr ON pinned_questions(url);
PRAGMA user_version=7;`;

const savedHunk = hunkLocation.extend({
  revision: z.string(),
  text: z.string(),
  basePath: z.string(),
  mergeBase: z.string().nullable(),
  partial: z.boolean(),
  uniqueBody: z.boolean().optional(),
});
type SavedHunk = z.infer<typeof savedHunk>;

function isLocated(status: unknown) {
  return ['pinned', 'unchanged', 'changed', 'moved'].includes(String(status));
}
function body(text: string) {
  return text.slice(text.indexOf('\n') + 1);
}
function oldRange(text: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+/.exec(text);
  if (!match) return null;
  const start = Number(match[1]),
    count = Number(match[2] ?? 1);
  return count ? ([start, start + count - 1] as const) : null;
}

// Prefer an identical body. For edited hunks use the same immutable base lines,
// or a distinctive pair of surviving lines. Split or duplicated matches stay open for inspection.
function locate(anchor: SavedHunk, hunks: string[], sameBase: boolean) {
  const original = body(anchor.text);
  const exact = hunks.flatMap((h, i) => (body(h) === original ? [i] : []));
  const range = oldRange(anchor.text);
  if (sameBase && range) {
    const overlapping = hunks.flatMap((h, i) => {
      const r = oldRange(h);
      return r && range[0] <= r[1] && r[0] <= range[1] ? [i] : [];
    });
    // These line numbers refer to the same immutable base blob. A duplicate in
    // another function cannot replace a hunk that disappeared at this location.
    return overlapping;
  }
  if (!anchor.uniqueBody) return exact.length > 1 ? exact : [];
  if (exact.length) return exact;
  const pairs = (text: string) => {
    const lines = text.split('\n');
    return lines.slice(1).flatMap((line, i) => {
      const previous = lines[i] ?? '';
      // Empty lines and punctuation alone have little identifying power.
      return /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(line)
        ? [previous + '\n' + line]
        : [];
    });
  };
  const savedPairs = new Set(pairs(original));
  return hunks.flatMap((h, i) => (pairs(body(h)).some((pair) => savedPairs.has(pair)) ? [i] : []));
}
function readHunk(value: unknown) {
  return savedHunk.parse(JSON.parse(String(value)));
}
function capture(
  revision: string,
  meta: ReviewMeta,
  info: FileInfo,
  hunk: number,
  text: string,
  hunks: string[],
): SavedHunk {
  return {
    revision,
    path: info.path,
    hunk,
    text,
    basePath: info.previousPath ?? info.path,
    mergeBase: meta.mergeBase ?? null,
    partial: info.kind === 'partial',
    uniqueBody: info.kind === 'text' && hunks.filter((h) => body(h) === body(text)).length === 1,
  };
}

export function questionStore(db: DatabaseSync) {
  const lookup = db.prepare('SELECT * FROM pinned_questions WHERE url=? AND id=?');
  function current(key: QuestionKey) {
    const row = db
      .prepare('SELECT meta FROM snapshots JOIN workspace ON active=url WHERE url=? AND revision=?')
      .get(key.url, key.revision);
    if (!row) throw Error('Reopen the current PR revision before changing its pinned questions.');
    return metadata.parse(JSON.parse(String(row.meta)));
  }
  function list(url: string): PinnedQuestion[] {
    const rows = db
      .prepare(
        `SELECT id,question,addressed,status,file_path,
      json_extract(origin,'$.path') AS path,json_extract(origin,'$.hunk') AS hunk,json_extract(origin,'$.revision') AS revision,
      json_extract(last_match,'$.hunk') AS latest_hunk FROM pinned_questions WHERE url=? ORDER BY addressed,rowid`,
      )
      .all(url);
    return rows.map((row) =>
      pinnedQuestion.parse({
        ...row,
        addressed: row.addressed === 1,
        origin: { path: row.path, hunk: row.hunk, revision: row.revision },
        filePath: row.file_path,
        current: isLocated(row.status) ? { path: row.file_path, hunk: row.latest_hunk } : null,
      }),
    );
  }
  return {
    list,
    pin(req: PinQuestion) {
      const meta = current(req);
      const existing = lookup.get(req.url, req.id);
      if (existing) {
        const origin = readHunk(existing.origin);
        if (
          existing.question !== req.question ||
          origin.path !== req.path ||
          origin.hunk !== req.hunk ||
          origin.revision !== req.revision
        )
          throw Error('This pin already belongs to another question.');
        return list(req.url);
      }
      const file = db
        .prepare('SELECT info,patch FROM review_files WHERE url=? AND path=?')
        .get(req.url, req.path);
      if (!file) throw Error('The file is unavailable in this revision.');
      const info = fileInfo.parse(JSON.parse(String(file.info)));
      const patch = String(file.patch);
      const hunks = splitHunks(patch);
      const text = hunks[req.hunk];
      if (!text?.startsWith('@@ ') || !['text', 'partial'].includes(info.kind))
        throw Error('Choose a visible text hunk to pin a question.');
      const anchor = JSON.stringify(capture(req.revision, meta, info, req.hunk, text, hunks));
      db.prepare(
        "INSERT INTO pinned_questions(id,url,question,origin,last_match,status,file_path) VALUES(?,?,?,?,?,'pinned',?)",
      ).run(req.id, req.url, req.question, anchor, anchor, req.path);
      return list(req.url);
    },
    address(key: QuestionKey, addressed: boolean) {
      current(key);
      if (
        !db
          .prepare('UPDATE pinned_questions SET addressed=? WHERE url=? AND id=?')
          .run(Number(addressed), key.url, key.id).changes
      )
        throw Error('Pinned question unavailable.');
      return list(key.url);
    },
    evidence(key: QuestionKey) {
      current(key);
      const row = lookup.get(key.url, key.id);
      if (!row) throw Error('Pinned question unavailable.');
      const origin = readHunk(row.origin);
      const last = readHunk(row.last_match);
      return {
        original: origin.text,
        originalPartial: origin.partial,
        current: last.revision === key.revision && isLocated(row.status) ? last.text : null,
      };
    },
    // Run inside the snapshot installation transaction, after coverage has been reconciled.
    sync(url: string, revision: string, meta: ReviewMeta) {
      const rows = db
        .prepare('SELECT id,origin,last_match FROM pinned_questions WHERE url=?')
        .all(url);
      if (!rows.length) return;
      const infos = db
        .prepare('SELECT info FROM review_files WHERE url=?')
        .all(url)
        .map((row) => fileInfo.parse(JSON.parse(String(row.info))));
      const cache = new Map<string, string[]>();
      const update = db.prepare(
        'UPDATE pinned_questions SET status=?,file_path=?,last_match=COALESCE(?,last_match) WHERE id=?',
      );
      for (const row of rows) {
        const id = z.uuid().parse(row.id);
        const origin = readHunk(row.origin);
        const last = readHunk(row.last_match);
        const anchor = origin.revision === revision ? origin : last;
        const candidates = infos.filter(
          (f) =>
            f.path === anchor.path ||
            (!!anchor.mergeBase &&
              anchor.mergeBase === meta.mergeBase &&
              f.path === anchor.basePath &&
              !f.previousPath) ||
            (f.status === 'renamed' &&
              (f.previousPath === anchor.path || f.previousPath === anchor.basePath)),
        );
        const file = candidates[0];
        if (!file || candidates.length !== 1) {
          update.run(
            candidates.length > 1
              ? 'ambiguous'
              : infos.length < meta.totalFiles
                ? 'unavailable'
                : 'missing',
            null,
            null,
            id,
          );
          continue;
        }
        let hunks = cache.get(file.path);
        if (!hunks) {
          hunks = splitHunks(
            String(
              db
                .prepare('SELECT patch FROM review_files WHERE url=? AND path=?')
                .get(url, file.path)?.patch ?? '',
            ),
          );
          cache.set(file.path, hunks);
        }
        const pinnedLocation =
          anchor.revision === revision &&
          anchor.path === file.path &&
          hunks[anchor.hunk] === anchor.text;
        if (!pinnedLocation && file.kind !== 'text') {
          update.run('unavailable', file.path, null, id);
          continue;
        }
        const sameBase =
          !!anchor.mergeBase &&
          anchor.mergeBase === meta.mergeBase &&
          anchor.basePath === (file.previousPath ?? file.path);
        // A complete fetch may extend a previously truncated added-file hunk
        // at the same immutable revision, even though it has no base-side lines.
        const extended =
          anchor.partial && anchor.revision === revision && anchor.path === file.path
            ? hunks.flatMap((h, i) => (h.startsWith(anchor.text) ? [i] : []))
            : [];
        const matches = pinnedLocation
          ? [anchor.hunk]
          : extended.length
            ? extended
            : locate(anchor, hunks, sameBase);
        const index = matches[0];
        const text = index === undefined ? undefined : hunks[index];
        if (matches.length !== 1 || index === undefined || !text) {
          update.run(matches.length > 1 ? 'ambiguous' : 'unmatched', file.path, null, id);
          continue;
        }
        const next = capture(revision, meta, file, index, text, hunks);
        const status =
          body(origin.text) !== body(text)
            ? 'changed'
            : origin.path !== file.path || origin.hunk !== index || origin.text !== text
              ? 'moved'
              : origin.revision === revision
                ? 'pinned'
                : 'unchanged';
        update.run(status, file.path, JSON.stringify(next), id);
      }
    },
  };
}
