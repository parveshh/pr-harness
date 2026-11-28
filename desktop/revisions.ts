import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { comparison, ancestry, type Comparison } from '../shared/rereview.js';
import { fileInfo, metadata, fileKey, type FileKey } from '../shared/reader.js';
import { draftStore } from './draft-store.js';
import type { Snapshot, HeadComparison } from './github.js';
import { relocate } from './anchors.js';

const createAbsentFiles =
  'CREATE TABLE IF NOT EXISTS absent_files(url TEXT NOT NULL, path TEXT NOT NULL, signature TEXT NOT NULL, last_reviewed TEXT, hunk INTEGER NOT NULL, scroll INTEGER NOT NULL, PRIMARY KEY(url,path)) STRICT;';

export const revisionMigration = `
CREATE TABLE revision_history(url TEXT NOT NULL, revision TEXT NOT NULL, meta TEXT NOT NULL, PRIMARY KEY(url,revision)) STRICT;
CREATE TABLE revision_files(url TEXT NOT NULL, revision TEXT NOT NULL, path TEXT NOT NULL, signature TEXT NOT NULL, patch TEXT NOT NULL, PRIMARY KEY(url,revision,path)) STRICT;
CREATE TABLE revision_state(url TEXT PRIMARY KEY REFERENCES snapshots(url), baseline TEXT NOT NULL, incoming TEXT, staged TEXT, comparison TEXT, since INTEGER NOT NULL DEFAULT 0, change_path TEXT) STRICT;
${createAbsentFiles}
CREATE TABLE incremental_patches(url TEXT NOT NULL, path TEXT NOT NULL, patch TEXT NOT NULL, PRIMARY KEY(url,path)) STRICT;
ALTER TABLE review_files ADD COLUMN last_reviewed TEXT;
UPDATE review_files SET last_reviewed=signature WHERE reviewed=1;
INSERT INTO revision_state(url,baseline) SELECT url,revision FROM snapshots;
PRAGMA user_version=6;`;

// Early v6 workspaces reached v9 without the later re-review navigation fields.
export function migrateRevisionNavigation(db: DatabaseSync) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(revision_state)')
      .all()
      .map((r) => r.name),
  );
  if (!columns.has('since'))
    db.exec('ALTER TABLE revision_state ADD COLUMN since INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('change_path'))
    db.exec('ALTER TABLE revision_state ADD COLUMN change_path TEXT');
  db.exec(createAbsentFiles);
  db.exec('PRAGMA user_version=10');
}

const staged = z.object({
  baseline: z.string(),
  snapshot: z.object({
    meta: metadata,
    revision: z.string(),
    files: z.array(z.object({ info: fileInfo, signature: z.string(), patch: z.string() })),
  }),
  heads: z.object({
    ancestry,
    partial: z.boolean(),
    files: z.array(z.object({ path: z.string(), patch: z.string().nullable() })),
  }),
});
export function revisionStore(db: DatabaseSync) {
  const drafts = draftStore(db);
  const archived = db.prepare(
    'SELECT signature,patch FROM revision_files WHERE url=? AND revision=? AND path=?',
  );
  function state(url: string) {
    return db
      .prepare(
        'SELECT baseline,incoming,comparison,since,change_path FROM revision_state WHERE url=?',
      )
      .get(url);
  }
  function clearStage(url: string) {
    db.prepare('UPDATE revision_state SET staged=NULL,incoming=NULL WHERE url=?').run(url);
  }
  function archive(url: string) {
    db.prepare(
      'INSERT OR REPLACE INTO revision_history SELECT url,revision,meta FROM snapshots WHERE url=?',
    ).run(url);
    db.prepare(
      'INSERT OR REPLACE INTO revision_files SELECT url,revision,path,signature,patch FROM snapshots JOIN review_files USING(url) WHERE url=?',
    ).run(url);
  }
  function compare(url: string, snapshot: Snapshot, heads: HeadComparison, showComparison = true) {
    const baseline = String(state(url)?.baseline);
    if (baseline === snapshot.revision) {
      db.prepare(
        'UPDATE revision_state SET comparison=NULL,since=0,change_path=NULL WHERE url=?',
      ).run(url);
      return;
    }
    const prior = metadata.parse(
      JSON.parse(
        String(
          db
            .prepare('SELECT meta FROM revision_history WHERE url=? AND revision=?')
            .get(url, baseline)?.meta,
        ),
      ),
    );
    const old = new Map(
      db
        .prepare('SELECT path,signature FROM revision_files WHERE url=? AND revision=?')
        .all(url, baseline)
        .map((row) => [String(row.path), row.signature]),
    );
    const incomplete = snapshot.files.length < snapshot.meta.totalFiles;
    const baselineIncomplete = old.size < prior.totalFiles;
    const files = new Map<string, Comparison['files'][number]['state']>();
    for (const { info, signature } of snapshot.files) {
      if (!old.has(info.path)) files.set(info.path, baselineIncomplete ? 'unconfirmed' : 'entered');
      else if (info.kind === 'partial' || info.kind === 'unavailable')
        files.set(info.path, 'unconfirmed');
      else if (old.get(info.path) !== signature) files.set(info.path, 'changed');
      old.delete(info.path);
    }
    for (const path of old.keys()) files.set(path, incomplete ? 'unconfirmed' : 'left');
    db.prepare('DELETE FROM incremental_patches WHERE url=?').run(url);
    const insert = db.prepare('INSERT OR REPLACE INTO incremental_patches VALUES(?,?,?)');
    for (const file of heads.files) {
      if (!files.has(file.path)) files.set(file.path, 'head-only');
      if (file.patch !== null) insert.run(url, file.path, file.patch);
    }
    const result: Comparison = {
      baseline,
      baseChanged:
        prior.base !== snapshot.meta.base || prior.baseBranch !== snapshot.meta.baseBranch,
      ancestry: heads.ancestry,
      partial: incomplete || baselineIncomplete || heads.partial,
      files: [...files].map(([path, state]) => ({ path, state })),
    };
    db.prepare('UPDATE revision_state SET comparison=?,since=?,change_path=NULL WHERE url=?').run(
      JSON.stringify(result),
      Number(showComparison),
      url,
    );
  }
  function reattach(url: string, snapshot: Snapshot) {
    const bundle = drafts.get(url);
    if (bundle.pending || !bundle.comments.length) return;
    const paths = new Map(snapshot.files.map((file) => [file.info.path, file]));
    let changed = false;
    const comments = bundle.comments.map((draft) => {
      if (draft.revision === snapshot.revision) return draft;
      const old = archived.get(url, draft.revision, draft.path);
      if (!old) return draft;
      // A PR's previous_filename is relative to its base. Only trust a rename if
      // the original path disappeared and no other new path claims it.
      const direct = paths.get(draft.path);
      const renames = snapshot.files.filter(
        (f) => f.info.status === 'renamed' && f.info.previousPath === draft.path,
      );
      const file = direct ?? (renames.length === 1 ? renames[0] : undefined);
      if (!file || (direct && renames.length) || file.info.kind !== 'text') return draft;
      const anchor = relocate(
        draft,
        String(old.patch),
        file.patch,
        old.signature === file.signature,
      );
      if (!anchor) return draft;
      changed = true;
      return { ...draft, ...anchor, path: file.info.path, revision: snapshot.revision };
    });
    if (changed) drafts.write(url, bundle.version, { ...bundle, comments });
  }
  return {
    archive,
    compare,
    reattach,
    clearStage,
    identify(url: string, revision: string, baseBranch: string) {
      const row = db
        .prepare(
          "SELECT json_extract(meta,'$.baseBranch') AS branch FROM snapshots WHERE url=? AND revision=? UNION ALL SELECT json_extract(meta,'$.baseBranch') FROM revision_history WHERE url=? AND revision=? LIMIT 1",
        )
        .get(url, revision, url, revision);
      // Retargeting to a branch at the same SHA leaves both commit IDs unchanged.
      return row && row.branch !== baseBranch
        ? revision.replace('...', '@' + encodeURIComponent(baseBranch) + '...')
        : revision;
    },
    baseline(url: string) {
      return String(state(url)?.baseline);
    },
    info(url: string) {
      const row = state(url);
      return {
        since: row?.since === 1,
        changePath: typeof row?.change_path === 'string' ? row.change_path : null,
        incoming: typeof row?.incoming === 'string' ? row.incoming : null,
        comparison: row?.comparison ? comparison.parse(JSON.parse(String(row.comparison))) : null,
      };
    },
    stage(url: string, snapshot: Snapshot, heads: HeadComparison, baseline: string) {
      db.prepare('UPDATE revision_state SET incoming=?,staged=? WHERE url=?').run(
        snapshot.revision,
        JSON.stringify({ snapshot, heads, baseline }),
        url,
      );
    },
    pending(url: string, revision: string) {
      const row = db
        .prepare('SELECT staged FROM revision_state WHERE url=? AND incoming=?')
        .get(url, revision);
      if (!row?.staged) throw Error('A newer update is available. Check the update again.');
      const pending = staged.parse(JSON.parse(String(row.staged)));
      if (pending.baseline !== state(url)?.baseline)
        pending.heads = { ancestry: 'unknown', files: [], partial: true };
      return pending;
    },
    begin(url: string, revision: string) {
      db.prepare('INSERT OR IGNORE INTO revision_state(url,baseline) VALUES(?,?)').run(
        url,
        revision,
      );
    },
    finish(url: string, revision: string) {
      const result = db
        .prepare(
          'UPDATE revision_state SET baseline=?,comparison=NULL,since=0,change_path=NULL,staged=NULL,incoming=NULL WHERE url=? AND EXISTS(SELECT 1 FROM snapshots WHERE url=? AND revision=?) AND incoming IS NULL',
        )
        .run(revision, url, url, revision);
      if (!result.changes) throw Error('Open the latest update before saving a checkpoint.');
    },
    // A local review hands its brief to an agent that keeps editing, so an update is often
    // staged by the time the reviewer saves the checkpoint. The staged comparison does not
    // depend on the baseline, so it stays staged and is compared with the new checkpoint.
    checkpoint(url: string, revision: string) {
      const result = db
        .prepare(
          "UPDATE revision_state SET baseline=?,comparison=NULL,since=0,change_path=NULL,staged=CASE WHEN staged IS NULL THEN NULL ELSE json_set(staged,'$.baseline',?) END WHERE url=? AND EXISTS(SELECT 1 FROM snapshots WHERE url=? AND revision=?)",
        )
        .run(revision, revision, url, url, revision);
      if (!result.changes) throw Error('This revision is no longer current. Refresh the review.');
    },
    published(url: string, revision: string) {
      db.prepare(
        'UPDATE revision_state SET baseline=?,comparison=NULL,since=0,change_path=NULL WHERE url=? AND EXISTS(SELECT 1 FROM snapshots WHERE url=? AND revision=?)',
      ).run(revision, url, url, revision);
    },
    position(url: string, revision: string, since: boolean, path: string | null) {
      const result = db
        .prepare(
          'UPDATE revision_state SET since=?,change_path=? WHERE url=? AND comparison IS NOT NULL AND EXISTS(SELECT 1 FROM snapshots WHERE url=? AND revision=?)',
        )
        .run(Number(since), path, url, url, revision);
      if (!result.changes) throw Error('This comparison is no longer current.');
    },
    markAbsent({ url, revision, path }: FileKey, reviewed: boolean) {
      const row = db
        .prepare(
          'SELECT comparison FROM revision_state JOIN snapshots USING(url) WHERE url=? AND revision=? AND comparison IS NOT NULL AND NOT EXISTS(SELECT 1 FROM review_files WHERE url=? AND path=?)',
        )
        .get(url, revision, url, path);
      if (!row) throw Error('This file is no longer in this comparison.');
      const value = comparison.parse(JSON.parse(String(row.comparison)));
      const file = value.files.find((f) => f.path === path);
      if (!file) throw Error('File is outside this comparison.');
      file.reviewed = reviewed;
      db.prepare('UPDATE revision_state SET comparison=? WHERE url=?').run(
        JSON.stringify(value),
        url,
      );
    },
    original(key: FileKey) {
      return archived.get(key.url, key.revision, key.path)?.patch;
    },
    evidence(input: unknown) {
      const { url, path, revision } = fileKey.parse(input);
      const row = db
        .prepare(
          'SELECT baseline FROM revision_state JOIN snapshots USING(url) WHERE url=? AND revision=? AND comparison IS NOT NULL',
        )
        .get(url, revision);
      if (!row) throw Error('This comparison is no longer current.');
      const before = archived.get(url, String(row.baseline), path)?.patch;
      const after = db
        .prepare('SELECT patch FROM review_files WHERE url=? AND path=?')
        .get(url, path)?.patch;
      const incremental = db
        .prepare('SELECT patch FROM incremental_patches WHERE url=? AND path=?')
        .get(url, path)?.patch;
      return {
        before: typeof before === 'string' ? before : null,
        after: typeof after === 'string' ? after : null,
        incremental: typeof incremental === 'string' ? incremental : null,
      };
    },
    citationChanged(url: string, revision: string, path: string) {
      const row = db
        .prepare(
          'SELECT a.signature AS previous,f.signature AS current FROM revision_files a LEFT JOIN review_files f USING(url,path) WHERE a.url=? AND a.revision=? AND a.path=?',
        )
        .get(url, revision, path);
      return !row || row.previous !== row.current;
    },
  };
}
