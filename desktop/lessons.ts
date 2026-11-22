import type { DatabaseSync } from 'node:sqlite';
import { repoOf } from '../shared/assistant.js';
import { reviewLesson, type LessonKey, type ReviewLesson } from '../shared/lessons.js';

export const lessonMigration = `
  CREATE TABLE review_lessons (
    repository TEXT NOT NULL, source_url TEXT NOT NULL, thread_id INTEGER NOT NULL,
    path TEXT NOT NULL, note TEXT NOT NULL, fragment TEXT NOT NULL,
    PRIMARY KEY (repository, source_url, thread_id)
  ) STRICT;
  PRAGMA user_version = 14;`;

export function lessonStore(db: DatabaseSync) {
  const list =
    db.prepare(`SELECT source_url AS sourceUrl, thread_id AS threadId, path, note, fragment
    FROM review_lessons WHERE repository = ? ORDER BY path, source_url, thread_id`);
  return {
    list(url: string) {
      return reviewLesson.array().parse(list.all(repoOf(url)));
    },
    save(lesson: ReviewLesson) {
      db.prepare(
        `INSERT INTO review_lessons (repository, source_url, thread_id, path, note, fragment)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repository, source_url, thread_id)
        DO UPDATE SET path=excluded.path, note=excluded.note, fragment=excluded.fragment`,
      ).run(
        repoOf(lesson.sourceUrl),
        lesson.sourceUrl,
        lesson.threadId,
        lesson.path,
        lesson.note,
        lesson.fragment,
      );
    },
    forget(url: string, key: LessonKey) {
      db.prepare(
        'DELETE FROM review_lessons WHERE repository=? AND source_url=? AND thread_id=?',
      ).run(repoOf(url), key.sourceUrl, key.threadId);
    },
  };
}
