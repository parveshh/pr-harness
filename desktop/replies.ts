import { readReviewStatus, reviewActivityStore } from './review-activity.js';
import type { ReviewChange } from '../shared/workspace.js';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { login, readableError } from '../shared/assistant.js';
import { pullRequestUrl } from '../shared/reviews.js';
import { reply, type Inbox } from '../shared/workspace.js';
import { githubApi, replySession } from './github.js';

export const settingsMigration = `
ALTER TABLE workspace ADD COLUMN font TEXT NOT NULL DEFAULT 'system';
ALTER TABLE workspace ADD COLUMN font_size TEXT NOT NULL DEFAULT 'standard';
CREATE TABLE reply_watch(account TEXT NOT NULL,url TEXT NOT NULL,started TEXT NOT NULL,cursor TEXT NOT NULL,PRIMARY KEY(account,url)) STRICT;
CREATE TABLE reply_alerts(account TEXT NOT NULL,id INTEGER NOT NULL,url TEXT NOT NULL,author TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,unread INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(account,id)) STRICT;
CREATE INDEX reply_inbox ON reply_alerts(account,unread,created);
PRAGMA user_version=8;`;

// Register watches in the same SQLite mutation that makes a PR visible, including while offline.
export const replyTargetsMigration = `
CREATE TABLE reply_targets(url TEXT PRIMARY KEY,registered TEXT NOT NULL) STRICT;
CREATE VIEW tracked_pulls AS SELECT url FROM saved_reviews UNION SELECT 'https://github.com/'||name||'/pull/'||json_extract(p.value,'$.number') FROM repositories,json_each(pulls) p,json_each(watching) w WHERE json_extract(p.value,'$.author')=w.value;
INSERT INTO reply_targets SELECT url,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tracked_pulls;
CREATE TRIGGER track_saved AFTER INSERT ON saved_reviews BEGIN INSERT OR IGNORE INTO reply_targets VALUES(NEW.url,NEW.saved_at); END;
CREATE TRIGGER track_authors AFTER UPDATE OF watching,pulls ON repositories BEGIN
 INSERT OR IGNORE INTO reply_targets SELECT url,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tracked_pulls;
 DELETE FROM reply_targets WHERE url NOT IN (SELECT url FROM tracked_pulls);
END;
CREATE TRIGGER untrack_repo AFTER DELETE ON repositories BEGIN DELETE FROM reply_targets WHERE url NOT IN(SELECT url FROM tracked_pulls); END;
CREATE TRIGGER forget_cursor AFTER DELETE ON reply_targets BEGIN DELETE FROM reply_watch WHERE url=OLD.url; END;
PRAGMA user_version=9;`;

const remote = z.object({
  id: z.number().int().positive(),
  in_reply_to_id: z.number().int().positive().nullish(),
  user: z.object({ login }).nullable(),
  path: z.string(),
  body: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export function replyStore(db: DatabaseSync) {
  return {
    ...reviewActivityStore(db),
    targets() {
      return z
        .object({ url: pullRequestUrl, registered: z.string() })
        .array()
        .parse(
          db.prepare("SELECT * FROM reply_targets WHERE url LIKE 'https://github.com/%'").all(),
        );
    },
    watch(account: string, url: string, registered: string, now: string) {
      db.prepare(
        'INSERT OR IGNORE INTO reply_watch SELECT ?,url,?,? FROM reply_targets WHERE url=? AND registered=?',
      ).run(account, now, now, url, registered);
      return z
        .object({ started: z.string(), cursor: z.string() })
        .optional()
        .parse(
          db
            .prepare(
              'SELECT started,cursor FROM reply_watch JOIN reply_targets USING(url) WHERE account=? AND url=? AND registered=?',
            )
            .get(account, url, registered),
        );
    },
    record(
      account: string,
      url: string,
      registered: string,
      started: string,
      rows: z.infer<typeof remote>[],
      cursor: string,
    ) {
      if (
        !db
          .prepare(
            'SELECT 1 FROM reply_watch JOIN reply_targets USING(url) WHERE account=? AND url=? AND started=? AND registered=?',
          )
          .get(account, url, started, registered)
      )
        return 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        const insert = db.prepare(
          'INSERT OR IGNORE INTO reply_alerts(account,id,url,author,path,body,created) VALUES(?,?,?,?,?,?,?)',
        );
        let added = 0;
        for (const row of rows) {
          if (
            !row.in_reply_to_id ||
            row.user?.login === account ||
            Date.parse(row.created_at) < Date.parse(started)
          )
            continue;
          added += Number(
            insert.run(
              account,
              row.id,
              url,
              row.user?.login ?? 'Deleted account',
              row.path,
              (row.body ?? '').slice(0, 1800),
              row.created_at,
            ).changes,
          );
        }
        db.prepare('UPDATE reply_watch SET cursor=max(cursor,?) WHERE account=? AND url=?').run(
          cursor,
          account,
          url,
        );
        db.exec('COMMIT');
        return added;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    items(account: string) {
      const rows = db
        .prepare(
          'SELECT * FROM reply_alerts WHERE account=? ORDER BY unread DESC,created DESC,id DESC',
        )
        .all(account);
      return rows.map((r) => reply.parse({ ...r, unread: r.unread === 1 }));
    },
    mark(account: string, id?: number) {
      if (id === undefined)
        db.prepare('UPDATE reply_alerts SET unread=0 WHERE account=? AND unread=1').run(account);
      else db.prepare('UPDATE reply_alerts SET unread=0 WHERE account=? AND id=?').run(account, id);
    },
    thread(account: string, id: number) {
      const url = pullRequestUrl.parse(
        db.prepare('SELECT url FROM reply_alerts WHERE account=? AND id=?').get(account, id)?.url,
      );
      return url + '#discussion_r' + id;
    },
  };
}
export function replyMonitor(
  store: ReturnType<typeof replyStore>,
  shutdown: AbortSignal,
  session: (
    signal: AbortSignal,
  ) => Promise<
    Pick<Awaited<ReturnType<typeof replySession>>, 'actor' | 'serverTime' | 'api' | 'graphql'>
  > = replySession,
  identity = async (signal: AbortSignal) =>
    z.object({ login }).parse(JSON.parse(await githubApi('user', signal))).login,
  now = Date.now,
  notify: (changes: ReviewChange[], account: string) => void = () => {},
) {
  let actor: string | null = null,
    failure: string | null = null,
    pending: Promise<Inbox> | null = null;
  let sessionController = new AbortController();
  function invalidate() {
    sessionController.abort();
    sessionController = new AbortController();
    pending = null;
    actor = null;
    failure = null;
  }
  function state(added = 0): Inbox {
    return {
      account: actor,
      items: actor ? store.items(actor) : [],
      changes: actor ? store.changes(actor) : [],
      error: failure,
      added,
    };
  }
  async function check(signal: AbortSignal) {
    let added = 0;
    const changes: ReviewChange[] = [];
    try {
      const remoteSession = await session(signal);
      signal.throwIfAborted();
      const localTime = now();
      actor = remoteSession.actor;
      failure = null;
      const targets = store.targets();
      for (const { url, registered } of targets) {
        const age = Math.max(0, localTime - Date.parse(registered));
        const start = new Date(
          Math.floor((remoteSession.serverTime - age) / 1000) * 1000,
        ).toISOString();
        const watch = store.watch(remoteSession.actor, url, registered, start);
        if (!watch) continue;
        try {
          const status = await readReviewStatus(
            url,
            remoteSession.actor,
            remoteSession.graphql,
            signal,
          );
          signal.throwIfAborted();
          changes.push(
            ...store.observe(
              remoteSession.actor,
              url,
              registered,
              status,
              new Date(remoteSession.serverTime).toISOString(),
            ),
          );
        } catch (error) {
          signal.throwIfAborted();
          failure = readableError(error);
          if (/rate limit/i.test(failure)) break;
        }
        const since = new Date(Date.parse(watch.cursor) - 60000).toISOString();
        const path = new URL(url).pathname.slice(1).replace('/pull/', '/pulls/');
        const endpoint =
          'repos/' +
          path +
          '/comments?sort=updated&direction=asc&per_page=100&since=' +
          encodeURIComponent(since);
        try {
          const rows: z.infer<typeof remote>[] = [];
          for (let page = 1; ; page++) {
            const batch = remote
              .array()
              .parse(JSON.parse(await remoteSession.api(endpoint + '&page=' + page, signal)));
            rows.push(...batch);
            if (batch.length < 100) break;
          }
          signal.throwIfAborted();
          added += store.record(
            remoteSession.actor,
            url,
            registered,
            watch.started,
            rows,
            new Date(remoteSession.serverTime).toISOString(),
          );
        } catch (e) {
          signal.throwIfAborted();
          failure = readableError(e);
          if (/rate limit/i.test(failure)) break;
        }
      }
      if ((await identity(signal)) !== remoteSession.actor)
        throw Error('GitHub account changed. Refresh the reply inbox.');
      signal.throwIfAborted();
      added += changes.length;
      notify(changes, remoteSession.actor);
    } catch (e) {
      signal.throwIfAborted();
      actor = null;
      failure = readableError(e);
      added = 0;
    }
    return state(added);
  }
  return {
    state,
    invalidate,
    sync() {
      if (pending) return pending;
      const signal = AbortSignal.any([shutdown, sessionController.signal]);
      pending = check(signal).finally(() => {
        if (!signal.aborted) pending = null;
      });
      return pending;
    },
    async verify(account: string) {
      const signal = AbortSignal.any([shutdown, sessionController.signal]);
      if (!actor || actor !== account || (await identity(signal)) !== account)
        throw Error('Refresh the inbox for the connected GitHub account.');
      signal.throwIfAborted();
    },
  };
}
