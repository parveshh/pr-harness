import type { DatabaseSync } from 'node:sqlite';
import { reviewBundle, type Bundle } from '../shared/publish.js';

export const draftMigration = `
CREATE TABLE review_drafts (
  url TEXT PRIMARY KEY REFERENCES saved_reviews(url),
  version INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;
PRAGMA user_version=4;`;

export function draftStore(db: DatabaseSync) {
  function get(url: string): Bundle {
    const row = db.prepare('SELECT data FROM review_drafts WHERE url=?').get(url);
    return row
      ? reviewBundle.parse(JSON.parse(String(row.data)))
      : { version: 0, comments: [], summary: '', event: 'COMMENT', pending: null, receipt: null };
  }
  function write(url: string, version: number, next: Bundle) {
    const bundle = reviewBundle.parse({ ...next, version: version + 1 });
    const data = JSON.stringify(bundle);
    const result =
      version === 0
        ? db
            .prepare('INSERT INTO review_drafts VALUES(?,?,?) ON CONFLICT DO NOTHING')
            .run(url, 1, data)
        : db
            .prepare('UPDATE review_drafts SET data=?,version=? WHERE url=? AND version=?')
            .run(data, bundle.version, url, version);
    if (!result.changes) throw Error('Drafts changed. Reopen the review preview and try again.');
    return bundle;
  }
  return { get, write };
}
