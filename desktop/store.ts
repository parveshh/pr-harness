import type { Bundle } from '../shared/publish.js';
import { typography } from '../shared/workspace.js';
import { replyStore, settingsMigration, replyTargetsMigration } from './replies.js';
import { questionMigration } from './questions.js';
import { migrateRevisionNavigation, revisionMigration } from './revisions.js';
import { appearance } from '../shared/appearance.js';
import { draftStore, draftMigration } from './draft-store.js';
import { DatabaseSync } from 'node:sqlite';
import { assistantMigration, assistantStore, migrateDefaultPrompt } from './assistant-store.js';
import { readerMigration, readerStore } from './reader-store.js';
import { pullRequestUrl, reviewList } from '../shared/reviews.js';

export function openStore(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || version < 0 || version > 11)
      throw new Error('This workspace requires a newer Local Reviewer.');
    if (version === 0) {
      db.exec(`CREATE TABLE saved_reviews (url TEXT PRIMARY KEY, saved_at TEXT NOT NULL) STRICT;
               PRAGMA user_version = 1;`);
    }
    if (version < 2) db.exec(readerMigration);
    if (version < 3) db.exec(assistantMigration);
    if (version < 4) db.exec(draftMigration);
    if (version < 5)
      db.exec(
        "ALTER TABLE workspace ADD COLUMN appearance TEXT NOT NULL DEFAULT 'petrol'; PRAGMA user_version=5;",
      );
    if (version < 6) db.exec(revisionMigration);
    if (version < 7) db.exec(questionMigration);
    if (version < 8) db.exec(settingsMigration);
    if (version < 9) db.exec(replyTargetsMigration);
    if (version < 10) migrateRevisionNavigation(db);
    if (version < 11) migrateDefaultPrompt(db);
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    throw error;
  }
  const list = db.prepare(
    'SELECT url, saved_at AS savedAt FROM saved_reviews ORDER BY saved_at DESC, url',
  );
  const insert = db.prepare(
    'INSERT INTO saved_reviews (url, saved_at) VALUES (?, ?) ON CONFLICT(url) DO NOTHING',
  );
  const drafts = draftStore(db);
  const reader = readerStore(db);
  return {
    replies: replyStore(db),
    typography: () =>
      typography.parse(db.prepare('SELECT font,font_size AS size FROM workspace WHERE id=1').get()),
    saveTypography(input: unknown) {
      const value = typography.parse(input);
      db.prepare('UPDATE workspace SET font=?,font_size=? WHERE id=1').run(value.font, value.size);
      return value;
    },
    getAppearance: () =>
      appearance.parse(db.prepare('SELECT appearance FROM workspace WHERE id=1').get()?.appearance),
    saveAppearance(value: unknown) {
      db.prepare('UPDATE workspace SET appearance=? WHERE id=1').run(appearance.parse(value));
    },
    recordPublication(url: string, version: number, bundle: Bundle, revision: string | undefined) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const saved = drafts.write(url, version, bundle);
        if (revision) reader.revisions.published(url, revision);
        db.exec('COMMIT');
        return saved;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    drafts,
    assistant: assistantStore(db),
    reader,
    list: () => reviewList.parse(list.all()),
    save(input: unknown) {
      const url = pullRequestUrl.parse(input);
      insert.run(url, new Date().toISOString());
      return reviewList.parse(list.all());
    },
    close: () => db.close(),
  };
}
