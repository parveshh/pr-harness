import type { LocalFolder } from './local.js';
import type { Repository } from './assistant.js';
import { isInactivePull, type LocalReviewInfo, type SavedReview } from './reviews.js';

export function reviewRepository(url: string, local?: LocalReviewInfo) {
  return local?.path ?? new URL(url).pathname.split('/').slice(1, 3).join('/');
}

export interface RepositoryGroup {
  kind: 'github' | 'local';
  key: string;
  label: string;
  monitored?: Repository;
  pulls: { url: string; pull: Repository['pulls'][number] }[];
  saved: SavedReview[];
}

export function groupReviews(
  repositories: Repository[],
  reviews: SavedReview[],
  folders: LocalFolder[] = [],
) {
  const groups = new Map<string, RepositoryGroup>();
  const listed = new Map<string, RepositoryGroup['pulls'][number]>();
  const inactive = new Set(
    reviews.filter((review) => isInactivePull(review.state)).map((review) => review.url),
  );
  for (const monitored of repositories) {
    const key = monitored.name;
    const pulls = monitored.pulls
      .filter((pull) => monitored.watching.includes(pull.author))
      .map((pull) => ({ url: 'https://github.com/' + key + '/pull/' + pull.number, pull }))
      .filter(({ url }) => !inactive.has(url));
    for (const row of pulls) listed.set(row.url, row);
    groups.set(key, {
      kind: 'github',
      key,
      label: key.split('/')[1] ?? key,
      monitored,
      pulls,
      saved: [],
    });
  }
  for (const folder of folders) {
    groups.set(folder.path, {
      kind: 'local',
      key: folder.path,
      label: folder.repository,
      pulls: [],
      saved: [],
    });
  }
  for (const review of reviews) {
    const monitoredRow = listed.get(review.url);
    if (monitoredRow) {
      if (monitoredRow.pull.isDraft === undefined && review.isDraft !== undefined)
        monitoredRow.pull = { ...monitoredRow.pull, isDraft: review.isDraft };
      if (!monitoredRow.pull.openedAt && review.openedAt)
        monitoredRow.pull = { ...monitoredRow.pull, openedAt: review.openedAt };
      const { pull } = monitoredRow;
      if (review.head && (!pull.head || pull.head === review.head)) {
        monitoredRow.pull = {
          ...pull,
          head: review.head,
          commitCount: pull.commitCount ?? review.commitCount,
          approvalStage: pull.approvalStage ?? review.approvalStage,
        };
      }
      continue;
    }
    const key = reviewRepository(review.url, review.local);
    const group: RepositoryGroup = groups.get(key) ?? {
      kind: review.local ? 'local' : 'github',
      key,
      label: review.local?.repository ?? key.split('/')[1] ?? key,
      pulls: [],
      saved: [],
    };
    if (!groups.has(key)) groups.set(key, group);
    if (!inactive.has(review.url)) group.saved.push(review);
  }
  const labels = new Set<string>();
  const ambiguous = new Set<string>();
  for (const { kind, label } of groups.values()) {
    const identity = kind + ':' + label;
    if (labels.has(identity)) ambiguous.add(identity);
    labels.add(identity);
  }
  for (const group of groups.values()) {
    if (ambiguous.has(group.kind + ':' + group.label)) group.label = group.key;
  }
  return groups;
}
