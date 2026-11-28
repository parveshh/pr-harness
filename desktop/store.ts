import { migratePullReviewStatus, migrateReviewActivity } from './review-activity.js';
import { findingStore } from './finding-store.js';
import { lessonMigration, lessonStore } from './lessons.js';
import type { Bundle } from '../shared/publish.js';
import { typography } from '../shared/workspace.js';
import { replyStore, settingsMigration, replyTargetsMigration } from './replies.js';
import { questionMigration } from './questions.js';
import { migrateRevisionNavigation, revisionMigration } from './revisions.js';
import { accent, appearance } from '../shared/appearance.js';
import { draftStore, draftMigration } from './draft-store.js';
import { DatabaseSync } from 'node:sqlite';
import {
  assistantMigration,
  assistantStore,
  migrateDetailedReviewPrompt,
  migrateFileOverviewPrompt,
  migrateGlobalSelection,
} from './assistant-store.js';
import { readerMigration, readerStore } from './reader-store.js';
import { pullRequestUrl, reviewList } from '../shared/reviews.js';
import {
  ensureLocalReviewSchema,
  localFolderMigration,
  localReviewMigration,
  localStore,
} from './local-store.js';
import {
  ensureReviewRequestSchema,
  reviewRequestMigration,
  reviewRequestStore,
} from './review-requests.js';

export function openStore(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || version < 0 || version > 29)
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
    if (version < 11) migrateFileOverviewPrompt(db);
    if (version < 12) migrateGlobalSelection(db);
    if (version < 13)
      db.exec(
        "ALTER TABLE workspace ADD COLUMN accent TEXT NOT NULL DEFAULT 'neutral'; PRAGMA user_version=13;",
      );
    if (version < 14) db.exec(lessonMigration);
    if (version < 15) migrateDetailedReviewPrompt(db);
    if (version < 16) db.exec(localReviewMigration);
    if (version < 18) migrateReviewActivity(db);
    if (version < 20) migratePullReviewStatus(db, version);
    if (version < 22) {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
        url TEXT PRIMARY KEY REFERENCES saved_reviews(url), generation INTEGER NOT NULL
      ) STRICT;`);
      if (
        !db.prepare("SELECT 1 FROM pragma_table_info('conversation') WHERE name='generation'").get()
      )
        db.exec('ALTER TABLE conversation ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
      if (version === 21) {
        db.exec(`UPDATE conversation SET generation=-1 WHERE id <= (
          SELECT last_archived_id FROM chat_boundaries WHERE chat_boundaries.url=conversation.url
        ); DROP TABLE chat_boundaries;`);
      }
      db.exec('PRAGMA user_version=22');
    }
    if (version < 23) {
      if (
        !db
          .prepare("SELECT 1 FROM pragma_table_info('workspace') WHERE name='sidebar_vibrancy'")
          .get()
      )
        db.exec(
          'ALTER TABLE workspace ADD COLUMN sidebar_vibrancy INTEGER NOT NULL DEFAULT 0 CHECK (sidebar_vibrancy IN (0,1))',
        );
      db.exec('PRAGMA user_version=23');
    }
    if (version < 24)
      db.exec(`CREATE TABLE IF NOT EXISTS pull_lifecycle (
        url TEXT PRIMARY KEY REFERENCES reply_targets(url) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('OPEN','CLOSED','MERGED')),
        updated_at TEXT NOT NULL
      ) STRICT; PRAGMA user_version=24;`);
    if (version < 25) {
      if (!db.prepare("SELECT 1 FROM pragma_table_info('workspace') WHERE name='code_font'").get())
        db.exec("ALTER TABLE workspace ADD COLUMN code_font TEXT NOT NULL DEFAULT 'system'");
      db.exec(`UPDATE workspace SET font_size = CASE font_size
        WHEN 'small' THEN '14.4' WHEN 'standard' THEN '16'
        WHEN 'large' THEN '18' WHEN 'larger' THEN '20' ELSE font_size END;
        PRAGMA user_version=25;`);
    }
    if (version < 26) db.exec(reviewRequestMigration);
    if (version < 27) {
      if (
        !db
          .prepare("SELECT 1 FROM pragma_table_info('workspace') WHERE name='single_key_shortcuts'")
          .get()
      )
        db.exec(
          'ALTER TABLE workspace ADD COLUMN single_key_shortcuts INTEGER NOT NULL DEFAULT 1 CHECK (single_key_shortcuts IN (0,1))',
        );
      db.exec('PRAGMA user_version=27');
    }
    // Old pixel offsets were relative to one hunk. Resume at its first row in the full file.
    if (version < 28)
      db.exec(
        'UPDATE review_files SET scroll=0; UPDATE absent_files SET scroll=0; PRAGMA user_version=28',
      );
    ensureLocalReviewSchema(db);
    if (version < 29) db.exec(localFolderMigration);
    ensureReviewRequestSchema(db);
    if (version === 0)
      db.prepare('UPDATE workspace SET appearance=?, accent=? WHERE id=1').run('ink', 'green');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    throw error;
  }
  const list = db.prepare(
    `SELECT url, saved_at AS savedAt, pull_lifecycle.state, draft, repository, branch, base_name AS baseBranch, repo_path AS path,
            CASE WHEN json_valid(snapshots.meta) THEN json_extract(snapshots.meta,'$.title') END AS title,
            CASE WHEN local_reviews.url IS NULL AND json_valid(snapshots.meta) THEN json_extract(snapshots.meta,'$.author') END AS author,
            CASE WHEN local_reviews.url IS NULL AND json_valid(snapshots.meta) THEN json_extract(snapshots.meta,'$.openedAt') END AS openedAt,
            COALESCE(pull_review_status.head, CASE WHEN local_reviews.url IS NULL AND json_valid(snapshots.meta) THEN json_extract(snapshots.meta,'$.head') END) AS head,
            CASE WHEN pull_review_status.head IS NOT NULL THEN commit_count WHEN local_reviews.url IS NULL AND json_valid(snapshots.meta) THEN json_extract(snapshots.meta,'$.commitCount') END AS commitCount,
            approval_stage AS approvalStage
     FROM saved_reviews LEFT JOIN pull_lifecycle USING(url) LEFT JOIN local_reviews USING(url) LEFT JOIN pull_draft_status USING(url) LEFT JOIN snapshots USING(url) LEFT JOIN pull_review_status USING(url) ORDER BY saved_at DESC, url`,
  );
  const listReviews = () =>
    reviewList.parse(
      list
        .all()
        .map(
          ({
            url,
            savedAt,
            state,
            draft,
            title,
            author,
            openedAt,
            head,
            commitCount,
            approvalStage,
            repository,
            ...local
          }) => ({
            url,
            savedAt,
            ...(state === null ? {} : { state }),
            ...(typeof title === 'string' ? { title } : {}),
            ...(typeof author === 'string' && author !== 'Unknown author' ? { author } : {}),
            ...(typeof openedAt === 'string' ? { openedAt } : {}),
            ...(typeof head === 'string' ? { head } : {}),
            ...(typeof commitCount === 'number' ? { commitCount } : {}),
            ...(approvalStage === null ? {} : { approvalStage }),
            ...(draft === null ? {} : { isDraft: draft === 1 }),
            ...(repository === null ? {} : { local: { repository, ...local } }),
          }),
        ),
    );
  const insert = db.prepare(
    'INSERT INTO saved_reviews (url, saved_at) VALUES (?, ?) ON CONFLICT(url) DO NOTHING',
  );
  const drafts = draftStore(db);
  const reader = readerStore(db);
  return {
    findings: findingStore(
      db,
      drafts,
      (url) => reader.read(url)?.revision,
      (url, revision, path) => reader.patch({ url, revision, path }),
    ),
    replies: replyStore(db),
    lessons: lessonStore(db),
    typography: () =>
      typography.parse(
        db
          .prepare('SELECT font,font_size AS size, code_font AS codeFont FROM workspace WHERE id=1')
          .get(),
      ),
    saveTypography(input: unknown) {
      const value = typography.parse(input);
      db.prepare('UPDATE workspace SET font=?,font_size=?,code_font=? WHERE id=1').run(
        value.font,
        value.size,
        value.codeFont,
      );
      return value;
    },
    getAppearance: () =>
      appearance
        .catch('ink')
        .parse(db.prepare('SELECT appearance FROM workspace WHERE id=1').get()?.appearance),
    saveAppearance(value: unknown) {
      db.prepare('UPDATE workspace SET appearance=? WHERE id=1').run(appearance.parse(value));
    },
    getSidebarVibrancy: () =>
      db.prepare('SELECT sidebar_vibrancy FROM workspace WHERE id=1').get()?.sidebar_vibrancy === 1,
    saveSidebarVibrancy(enabled: boolean) {
      db.prepare('UPDATE workspace SET sidebar_vibrancy=? WHERE id=1').run(Number(enabled));
    },
    getSingleKeyShortcuts: () =>
      db.prepare('SELECT single_key_shortcuts FROM workspace WHERE id=1').get()
        ?.single_key_shortcuts !== 0,
    saveSingleKeyShortcuts(enabled: boolean) {
      db.prepare('UPDATE workspace SET single_key_shortcuts=? WHERE id=1').run(Number(enabled));
    },
    getAccent: () =>
      accent.parse(db.prepare('SELECT accent FROM workspace WHERE id=1').get()?.accent),
    saveAccent(value: unknown) {
      db.prepare('UPDATE workspace SET accent=? WHERE id=1').run(accent.parse(value));
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
    local: localStore(db),
    reviewRequests: reviewRequestStore(db),
    list: listReviews,
    save(input: unknown) {
      const url = pullRequestUrl.parse(input);
      insert.run(url, new Date().toISOString());
      return listReviews();
    },
    close: () => db.close(),
  };
}
