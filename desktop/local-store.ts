import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localReviewKey } from '../shared/reviews.js';

// Local branch reviews are keyed by an opaque `local://` id. The repository path lives only
// here. Reply alerts follow GitHub pull requests, so local keys never become reply targets.
// `detached` is the commit a detached-HEAD review started from; it is NULL on a branch.
const localReviewTable = `
CREATE TABLE IF NOT EXISTS local_reviews (
  url TEXT PRIMARY KEY REFERENCES saved_reviews(url),
  repo_path TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_name TEXT NOT NULL,
  repository TEXT NOT NULL,
  branch TEXT,
  created TEXT NOT NULL,
  detached TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS local_reviews_repo ON local_reviews(repo_path, base_ref);`;
const replyTracking = `
DROP VIEW IF EXISTS tracked_pulls;
CREATE VIEW tracked_pulls AS SELECT url FROM saved_reviews WHERE url LIKE 'https://github.com/%' UNION SELECT 'https://github.com/'||name||'/pull/'||json_extract(p.value,'$.number') FROM repositories,json_each(pulls) p,json_each(watching) w WHERE json_extract(p.value,'$.author')=w.value;
DROP TRIGGER IF EXISTS track_saved;
CREATE TRIGGER track_saved AFTER INSERT ON saved_reviews WHEN NEW.url LIKE 'https://github.com/%'
  BEGIN INSERT OR IGNORE INTO reply_targets VALUES(NEW.url,NEW.saved_at); END;`;
export const localReviewMigration = localReviewTable + replyTracking + '\nPRAGMA user_version=16;';

// The reply tracking objects as version 15 created them.
const version15Tracking = [
  "CREATE VIEW tracked_pulls AS SELECT url FROM saved_reviews UNION SELECT 'https://github.com/'||name||'/pull/'||json_extract(p.value,'$.number') FROM repositories,json_each(pulls) p,json_each(watching) w WHERE json_extract(p.value,'$.author')=w.value",
  'CREATE TRIGGER track_saved AFTER INSERT ON saved_reviews BEGIN INSERT OR IGNORE INTO reply_targets VALUES(NEW.url,NEW.saved_at); END',
];
// A version 16 database can come from a build that predates local reviews or from another
// branch, so opening one makes sure the table exists. Reply tracking is upgraded only when it
// is exactly the version 15 definition; `replies.targets()` filters local keys either way.
export function ensureLocalReviewSchema(db: DatabaseSync) {
  db.exec(localReviewTable);
  const names = db
    .prepare("SELECT name FROM pragma_table_info('local_reviews')")
    .all()
    .map((c) => String(c.name));
  if (!names.includes('detached')) db.exec('ALTER TABLE local_reviews ADD COLUMN detached TEXT');
  const tracking = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE (type='view' AND name='tracked_pulls') OR (type='trigger' AND name='track_saved') ORDER BY type DESC",
    )
    .all()
    .map((r) => String(r.sql).replace(/\s+/g, ' ').trim());
  const old = version15Tracking.map((sql) => sql.replace(/\s+/g, ' '));
  if (tracking.length === 2 && tracking.every((sql, i) => sql === old[i])) db.exec(replyTracking);
}

const row = z.object({
  url: localReviewKey,
  path: z.string(),
  baseRef: z.string(),
  baseName: z.string(),
  repository: z.string(),
  branch: z.string().nullable(),
  detached: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
});
export type LocalReview = z.infer<typeof row>;
const columns =
  'url, repo_path AS path, base_ref AS baseRef, base_name AS baseName, repository, branch, detached';

export function localStore(db: DatabaseSync) {
  function get(input: unknown): LocalReview | null {
    const url = localReviewKey.parse(input);
    const found = db.prepare('SELECT ' + columns + ' FROM local_reviews WHERE url=?').get(url);
    return found ? row.parse(found) : null;
  }
  return {
    get,
    require(input: unknown) {
      const review = get(input);
      if (!review) throw Error('This local review is no longer saved.');
      return review;
    },
    // Reopening the same branch of the same clone against the same base continues its review.
    // A detached HEAD has no branch to follow, so each detached commit is its own review.
    save(input: Omit<LocalReview, 'url'>) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db
          .prepare(
            'SELECT url FROM local_reviews WHERE repo_path=? AND base_ref=? AND branch IS ? AND detached IS ? ORDER BY created LIMIT 1',
          )
          .get(input.path, input.baseRef, input.branch, input.branch ? null : input.detached);
        const now = new Date().toISOString();
        const url = existing ? localReviewKey.parse(existing.url) : 'local://' + randomUUID();
        if (!existing) {
          db.prepare('INSERT INTO saved_reviews (url, saved_at) VALUES (?, ?)').run(url, now);
          db.prepare(
            'INSERT INTO local_reviews (url, repo_path, base_ref, base_name, repository, branch, created, detached) VALUES (?,?,?,?,?,?,?,?)',
          ).run(
            url,
            input.path,
            input.baseRef,
            input.baseName,
            input.repository,
            input.branch,
            now,
            input.branch ? null : input.detached,
          );
        }
        db.exec('COMMIT');
        return url;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    list() {
      return db
        .prepare('SELECT ' + columns + ' FROM local_reviews')
        .all()
        .map((r) => row.parse(r));
    },
  };
}
