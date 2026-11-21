import type { DatabaseSync } from 'node:sqlite';
import {
  checkpoint,
  fileInfo,
  fileKey,
  metadata,
  splitHunks,
  type ReaderView,
} from '../shared/reader.js';
import { pullRequestUrl } from '../shared/reviews.js';
import { questionStore } from './questions.js';
import { revisionStore } from './revisions.js';
import type { HeadComparison, Snapshot } from './github.js';

export const readerMigration = `
CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), active TEXT REFERENCES saved_reviews(url)) STRICT;
INSERT INTO workspace(id) VALUES(1);
CREATE TABLE snapshots (url TEXT PRIMARY KEY REFERENCES saved_reviews(url), revision TEXT NOT NULL,
  meta TEXT NOT NULL, selected TEXT) STRICT;
CREATE TABLE review_files (url TEXT NOT NULL REFERENCES snapshots(url), path TEXT NOT NULL, ordinal INTEGER NOT NULL,
  info TEXT NOT NULL, patch TEXT NOT NULL, signature TEXT NOT NULL, hunks INTEGER NOT NULL,
  hunk INTEGER NOT NULL DEFAULT 0, scroll INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(url,path)) STRICT;
PRAGMA user_version=2;`;

export function readerStore(db: DatabaseSync) {
  const questions = questionStore(db);
  const revisions = revisionStore(db);
  const active = () =>
    pullRequestUrl
      .nullable()
      .parse(db.prepare('SELECT active FROM workspace WHERE id=1').get()?.active);
  function read(input: unknown): ReaderView | null {
    const url = pullRequestUrl.parse(input);
    const snapshot = db
      .prepare('SELECT meta,selected,revision FROM snapshots WHERE url=?')
      .get(url);
    if (!snapshot) return null;
    const files = db
      .prepare(
        'SELECT info,hunk,scroll,reviewed,last_reviewed FROM review_files WHERE url=? ORDER BY ordinal',
      )
      .all(url);
    return {
      ...revisions.info(url),
      questions: questions.list(url),
      meta: metadata.parse(JSON.parse(String(snapshot.meta))),
      selected: typeof snapshot.selected === 'string' ? snapshot.selected : null,
      revision: String(snapshot.revision),
      files: files.map((row) => ({
        ...fileInfo.parse(JSON.parse(String(row.info))),
        hunk: Number(row.hunk),
        scroll: Number(row.scroll),
        reviewed: row.reviewed === 1,
        ...(row.last_reviewed && !row.reviewed ? { needsReview: true as const } : {}),
      })),
    };
  }
  return {
    active,
    select(input: unknown) {
      const url = pullRequestUrl.nullable().parse(input);
      db.prepare('UPDATE workspace SET active=? WHERE id=1').run(url);
    },
    read,
    questions,
    revisions,
    install(
      url: string,
      snapshot: Snapshot,
      heads: HeadComparison = { ancestry: 'unknown', partial: true, files: [] },
    ) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare('SELECT selected,revision FROM snapshots WHERE url=?').get(url);
        const advanced = !!previous && previous.revision !== snapshot.revision;
        if (advanced) revisions.archive(url);
        const selected =
          snapshot.files.find((f) => f.info.path === previous?.selected)?.info.path ??
          snapshot.files[0]?.info.path ??
          null;
        db.prepare(
          `INSERT INTO snapshots VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET
          revision=excluded.revision,meta=excluded.meta,selected=excluded.selected`,
        ).run(url, snapshot.revision, JSON.stringify(snapshot.meta), selected);
        revisions.begin(url, snapshot.revision);
        const old = new Map(
          db
            .prepare(
              "SELECT path,ordinal,signature,last_reviewed,hunk,scroll,patch,json_extract(info,'$.kind') AS kind FROM review_files WHERE url=?",
            )
            .all(url)
            .map((row) => [String(row.path), row]),
        );
        const absent = new Map(
          db
            .prepare(
              'SELECT path,signature,last_reviewed,hunk,scroll FROM absent_files WHERE url=?',
            )
            .all(url)
            .map((row) => [String(row.path), row]),
        );
        const presentPaths = new Set(snapshot.files.map((f) => f.info.path));
        const forgetAbsent = db.prepare('DELETE FROM absent_files WHERE url=? AND path=?');
        const insert = db.prepare(
          'INSERT OR REPLACE INTO review_files(url,path,ordinal,info,patch,signature,hunks,last_reviewed,reviewed,hunk,scroll) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        );
        const reorder = db.prepare('UPDATE review_files SET ordinal=? WHERE url=? AND path=?');
        for (const [i, file] of snapshot.files.entries()) {
          const prior = old.get(file.info.path);
          const returning = absent.get(file.info.path);
          if (returning) forgetAbsent.run(url, file.info.path);
          const renamed =
            file.info.previousPath && !presentPaths.has(file.info.previousPath)
              ? old.get(file.info.previousPath)
              : undefined;
          const lastReviewed =
            prior?.last_reviewed ?? returning?.last_reviewed ?? renamed?.last_reviewed ?? null;
          old.delete(file.info.path);
          // A failed raw-diff request must not discard better evidence from this revision.
          const preserveCoverage =
            previous?.revision === snapshot.revision &&
            (file.info.kind === 'unavailable' ||
              (file.info.kind === 'partial' && prior?.kind === 'text'));
          const verifiable =
            !advanced || (file.info.kind !== 'partial' && file.info.kind !== 'unavailable');
          if (prior && ((verifiable && prior.signature === file.signature) || preserveCoverage)) {
            if (prior.ordinal !== i) reorder.run(i, url, file.info.path);
            continue;
          }
          if (
            prior &&
            !advanced &&
            prior.kind === file.info.kind &&
            (prior.kind === 'binary' || prior.kind === 'metadata')
          ) {
            // Version 5 fingerprints omitted raw metadata. The same pinned revision
            // lets us upgrade the fingerprint without losing the reviewed mark.
            db.prepare(
              'UPDATE review_files SET ordinal=?,signature=?,last_reviewed=CASE WHEN reviewed=1 THEN ? ELSE last_reviewed END WHERE url=? AND path=?',
            ).run(i, file.signature, file.signature, url, file.info.path);
            continue;
          }
          const restored = verifiable && returning?.signature === file.signature;
          const hunks = splitHunks(file.patch);
          const previousHunks = new Set(splitHunks(String(prior?.patch ?? '')));
          const firstChanged = prior
            ? Math.max(
                0,
                hunks.findIndex((h) => !previousHunks.has(h)),
              )
            : 0;
          insert.run(
            url,
            file.info.path,
            i,
            JSON.stringify(file.info),
            file.patch,
            file.signature,
            hunks.length,
            lastReviewed,
            Number(verifiable && lastReviewed === file.signature),
            restored ? Number(returning.hunk) : firstChanged,
            restored ? Number(returning.scroll) : 0,
          );
        }
        const remove = db.prepare('DELETE FROM review_files WHERE url=? AND path=?');
        const keepPosition = db.prepare(
          'INSERT OR REPLACE INTO absent_files(url,path,signature,last_reviewed,hunk,scroll) SELECT url,path,signature,last_reviewed,hunk,scroll FROM review_files WHERE url=? AND path=?',
        );
        for (const path of old.keys()) {
          keepPosition.run(url, path);
          remove.run(url, path);
        }
        if (advanced) {
          revisions.compare(url, snapshot, heads);
          revisions.reattach(url, snapshot);
        }
        questions.sync(url, snapshot.revision, snapshot.meta);
        revisions.clearStage(url);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return read(url);
    },
    patch(input: unknown) {
      const { url, revision, path } = fileKey.parse(input);
      const row = db
        .prepare(
          'SELECT patch FROM review_files JOIN snapshots USING(url) WHERE url=? AND revision=? AND path=?',
        )
        .get(url, revision, path);
      const patch = row?.patch ?? revisions.original({ url, revision, path });
      if (typeof patch !== 'string') throw new Error('This saved revision is unavailable.');
      return patch;
    },
    checkpoint(input: unknown) {
      const { url, revision, path, hunk, scroll, reviewed } = checkpoint.parse(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db
          .prepare(
            `UPDATE review_files SET hunk=?,scroll=?,last_reviewed=CASE WHEN ? THEN signature WHEN reviewed=1 THEN NULL ELSE last_reviewed END,reviewed=? WHERE url=? AND path=?
          AND ? < max(hunks,1) AND EXISTS(SELECT 1 FROM snapshots JOIN workspace ON active=url WHERE url=? AND revision=?)`,
          )
          .run(hunk, scroll, Number(reviewed), Number(reviewed), url, path, hunk, url, revision);
        if (!result.changes) throw new Error('This reading position belongs to an older view.');
        db.prepare('UPDATE snapshots SET selected=? WHERE url=?').run(path, url);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
