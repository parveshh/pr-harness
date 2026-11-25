import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { login, readableError, repoName } from '../shared/assistant.js';
import {
  reviewRequest,
  reviewRequestUrl,
  type ReviewRequest,
  type ReviewRequestInbox,
} from '../shared/review-requests.js';
import { githubGraphql, missingCliMessage, signInMessage, type Graphql } from './github.js';

// Each GitHub account keeps its own list, so switching accounts neither mixes the lists nor
// announces the other account's requests as new.
export const reviewRequestMigration = `
CREATE TABLE IF NOT EXISTS review_request_accounts(account TEXT PRIMARY KEY,checked TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS review_requests(
  account TEXT NOT NULL REFERENCES review_request_accounts(account) ON DELETE CASCADE,
  repo TEXT NOT NULL,number INTEGER NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,
  draft INTEGER NOT NULL CHECK(draft IN (0,1)),updated TEXT NOT NULL,head TEXT,
  via TEXT NOT NULL CHECK(via IN ('direct','team')),
  approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)),
  unseen INTEGER NOT NULL DEFAULT 0 CHECK(unseen IN (0,1)),
  PRIMARY KEY(account,repo,number)
) STRICT;
PRAGMA user_version=26;`;

type Requested = Omit<ReviewRequest, 'unseen'>;
const key = (request: Pick<ReviewRequest, 'repo' | 'number'>) =>
  request.repo + '#' + request.number;

export function reviewRequestStore(db: DatabaseSync) {
  function checked(account: string) {
    const value = db
      .prepare('SELECT checked FROM review_request_accounts WHERE account=?')
      .get(account)?.checked;
    return typeof value === 'string' ? value : null;
  }
  function list(account: string) {
    return reviewRequest.array().parse(
      db
        .prepare(
          `SELECT repo,number,title,author,draft,updated,head,via,approved,unseen FROM review_requests
           WHERE account=? ORDER BY updated DESC,repo,number DESC`,
        )
        .all(account)
        .map(({ draft, updated, approved, unseen, ...row }) => ({
          ...row,
          isDraft: draft === 1,
          updatedAt: updated,
          approved: approved === 1,
          unseen: unseen === 1,
        })),
    );
  }
  return {
    checked,
    list,
    // The account checked most recently, whose list is shown while GitHub cannot be reached.
    lastAccount() {
      const value = db
        .prepare('SELECT account FROM review_request_accounts ORDER BY checked DESC LIMIT 1')
        .get()?.account;
      return typeof value === 'string' ? value : null;
    },
    // Saves the list GitHub returned and reports the requests that arrived since the last
    // check. An account's first list establishes what is already waiting, so none of it is new.
    replace(account: string, requests: Requested[], now: string) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const first = checked(account) === null;
        // Marks are read here, after GitHub answered, so a PR opened meanwhile stays seen.
        const known = new Map(list(account).map((request) => [key(request), request.unseen]));
        db.prepare(
          `INSERT INTO review_request_accounts(account,checked) VALUES(?,?)
           ON CONFLICT(account) DO UPDATE SET checked=excluded.checked`,
        ).run(account, now);
        db.prepare('DELETE FROM review_requests WHERE account=?').run(account);
        const insert = db.prepare(
          `INSERT INTO review_requests(account,repo,number,title,author,draft,updated,head,via,approved,unseen)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        );
        const arrived: ReviewRequest[] = [];
        for (const request of requests) {
          const fresh = !first && !known.has(key(request));
          const unseen = known.get(key(request)) ?? fresh;
          insert.run(
            account,
            request.repo,
            request.number,
            request.title,
            request.author,
            Number(request.isDraft),
            request.updatedAt,
            request.head,
            request.via,
            Number(request.approved),
            Number(unseen),
          );
          if (fresh) arrived.push({ ...request, unseen });
        }
        db.exec('COMMIT');
        return arrived;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    // Opening a PR clears its new mark for whichever account was asked to review it.
    seen(url: string) {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url);
      if (!match) return false;
      return (
        db
          .prepare('UPDATE review_requests SET unseen=0 WHERE repo=? AND number=? AND unseen=1')
          .run(match[1] ?? '', Number(match[2])).changes > 0
      );
    },
    unseen(account: string) {
      return list(account)
        .filter((request) => request.unseen)
        .map(reviewRequestUrl);
    },
  };
}
export type ReviewRequestStore = ReturnType<typeof reviewRequestStore>;

// The requests worth a notification: the PR open on screen needs none.
export function requestsToAnnounce(arrived: ReviewRequest[], onScreen: string | null) {
  return arrived.filter((request) => reviewRequestUrl(request) !== onScreen);
}

// GitHub's search includes requests made to a team the account belongs to.
export const reviewRequestSearch = 'is:pr is:open review-requested:@me archived:false';
// One request returns the account and its requests together, so a list is never saved under
// another account's name. It also carries the head commit without a request per PR.
const searchQuery =
  'query ReviewRequests($q:String!,$after:String){viewer{login} search(query:$q,type:ISSUE,first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{__typename ... on PullRequest{number title isDraft updatedAt headRefOid author{login} repository{nameWithOwner} viewerLatestReview{state} reviewRequests(first:100){nodes{requestedReviewer{__typename ... on User{login}}}}}}}}';
const searchPage = z.object({
  data: z.object({
    viewer: z.object({ login }),
    search: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(z.looseObject({ __typename: z.string() }).nullable()),
    }),
  }),
});
const requestedPull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.iso.datetime(),
  headRefOid: z.string().min(1).nullish(),
  // GitHub returns no author once the account has been deleted.
  author: z.object({ login: z.string().min(1) }).nullable(),
  repository: z.object({ nameWithOwner: z.string() }),
  // An approval stays the latest review when the author asks for another look.
  viewerLatestReview: z.object({ state: z.string() }).nullish(),
  reviewRequests: z
    .object({
      nodes: z.array(
        z
          .object({
            requestedReviewer: z
              .object({ __typename: z.string(), login: z.string().optional() })
              .nullable(),
          })
          .nullable(),
      ),
    })
    .nullish(),
});
// GitHub's search returns at most 1000 results.
const maxPages = 10;

export function parseReviewRequestPage(json: string) {
  const { viewer, search } = searchPage.parse(JSON.parse(json)).data;
  const requests: Requested[] = [];
  for (const node of search.nodes) {
    if (node?.__typename !== 'PullRequest') continue;
    const pull = requestedPull.parse(node);
    // A repository the app cannot address by URL could not be opened from the list.
    const repo = repoName.safeParse(pull.repository.nameWithOwner);
    if (!repo.success) continue;
    const direct = pull.reviewRequests?.nodes.some(
      (request) =>
        request?.requestedReviewer?.__typename === 'User' &&
        request.requestedReviewer.login?.toLowerCase() === viewer.login,
    );
    requests.push({
      repo: repo.data,
      number: pull.number,
      title: pull.title,
      author: pull.author?.login ?? 'ghost',
      isDraft: pull.isDraft,
      updatedAt: pull.updatedAt,
      head: pull.headRefOid ?? null,
      via: direct ? 'direct' : 'team',
      approved: pull.viewerLatestReview?.state === 'APPROVED',
    });
  }
  return {
    account: viewer.login,
    requests,
    next: search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null,
  };
}

export async function fetchReviewRequests(signal: AbortSignal, graphql: Graphql = githubGraphql) {
  let account: string | null = null;
  let after: string | null = null;
  const found = new Map<string, Requested>();
  for (let page = 0; page < maxPages; page++) {
    const json = await graphql(
      searchQuery,
      { q: reviewRequestSearch, ...(after === null ? {} : { after }) },
      signal,
    );
    signal.throwIfAborted();
    let part: ReturnType<typeof parseReviewRequestPage>;
    try {
      part = parseReviewRequestPage(json);
    } catch (cause) {
      throw new Error('GitHub returned a review request list the app could not read. Retry.', {
        cause,
      });
    }
    if (account !== null && part.account !== account)
      throw new Error('GitHub account changed. Refresh the review requests.');
    account = part.account;
    for (const request of part.requests) found.set(key(request), request);
    after = part.next;
    if (after === null) break;
  }
  if (account === null) throw new Error('GitHub did not name the signed-in account.');
  return { account, requests: [...found.values()] };
}

type Session =
  { kind: 'account'; account: string } | { kind: 'signed-out'; message: string } | null;

export function reviewRequestMonitor(
  store: ReviewRequestStore,
  shutdown: AbortSignal,
  graphql: Graphql = githubGraphql,
  // Told about requests that appeared since the account's previous check.
  onNew: (requests: ReviewRequest[], account: string) => void = () => {},
  now: () => number = Date.now,
) {
  let session: Session = null,
    failure: string | null = null,
    pending: Promise<ReviewRequestInbox> | null = null;
  let sessionController = new AbortController();
  function listedAccount() {
    if (session?.kind === 'signed-out') return null;
    return session?.account ?? store.lastAccount();
  }
  function state(): ReviewRequestInbox {
    if (session?.kind === 'signed-out') return { state: 'signed-out', message: session.message };
    const account = listedAccount();
    const checked = account === null ? null : store.checked(account);
    if (account === null || checked === null)
      return failure === null ? { state: 'pending' } : { state: 'unavailable', message: failure };
    return { state: 'listed', account, requests: store.list(account), checked, error: failure };
  }
  async function check(signal: AbortSignal) {
    try {
      const { account, requests } = await fetchReviewRequests(signal, graphql);
      signal.throwIfAborted();
      const arrived = store.replace(account, requests, new Date(now()).toISOString());
      session = { kind: 'account', account };
      failure = null;
      try {
        if (arrived.length) onNew(arrived, account);
      } catch {
        // The list is saved. A notification that could not be shown is not a failed check.
      }
    } catch (error) {
      // A check dropped by a sign-in or by quitting says nothing about GitHub.
      if (signal.aborted) return state();
      const message = readableError(error);
      if (message === signInMessage || message === missingCliMessage) {
        session = { kind: 'signed-out', message };
        failure = null;
      } else {
        // The saved list of the last account stays on show while GitHub cannot be reached.
        if (session?.kind === 'signed-out') session = null;
        failure = message;
      }
    }
    return state();
  }
  return {
    state,
    // New requests for the account whose list is on show.
    unseen() {
      const account = listedAccount();
      return account === null ? [] : store.unseen(account);
    },
    // Signing in may change the account, so an answer already on its way is dropped.
    invalidate() {
      sessionController.abort();
      sessionController = new AbortController();
      pending = null;
      session = null;
      failure = null;
    },
    sync() {
      if (pending) return pending;
      const signal = AbortSignal.any([shutdown, sessionController.signal]);
      const work: Promise<ReviewRequestInbox> = check(signal).finally(() => {
        if (pending === work) pending = null;
      });
      pending = work;
      return work;
    },
  };
}
