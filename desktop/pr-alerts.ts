import { reviewChangeTitle, type ReviewChange } from '../shared/workspace.js';
import type { Repository } from '../shared/assistant.js';
import { reviewRequestUrl, type ReviewRequest } from '../shared/review-requests.js';

type Pull = Repository['pulls'][number];
// What the desktop shell provides: a system notification and a count on the app icon.
export type AlertPort = {
  notify(title: string, body: string, onClick: () => void): void;
  badge(count: number): void;
};

// Tells the reviewer about pull requests that have just appeared in a monitored
// repository. Titles come from GitHub and are shown as plain text.
export function prAlerts(port: AlertPort, open: (url: string) => void) {
  return {
    announce(repo: string, pulls: Pull[]) {
      const [first] = pulls;
      if (!first) return;
      const link = 'https://github.com/' + repo + '/pull/' + first.number;
      if (pulls.length === 1)
        port.notify(
          'New pull request in ' + repo,
          '#' + first.number + ' ' + first.title.slice(0, 140) + '\n@' + first.author,
          () => open(link),
        );
      else
        port.notify(
          pulls.length + ' new pull requests in ' + repo,
          pulls
            .slice(0, 4)
            .map((p) => '#' + p.number + ' ' + p.title.slice(0, 60))
            .join('\n') + (pulls.length > 4 ? '\n…' : ''),
          () => open(link),
        );
    },
    // Tells the reviewer that their review has just been requested.
    requested(requests: ReviewRequest[]) {
      const [first] = requests;
      if (!first) return;
      const link = reviewRequestUrl(first);
      if (requests.length === 1)
        port.notify(
          'Review requested in ' + first.repo,
          '#' + first.number + ' ' + first.title.slice(0, 140) + '\n@' + first.author,
          () => open(link),
        );
      else
        port.notify(
          requests.length + ' new review requests',
          requests
            .slice(0, 4)
            .map((r) => (r.repo + '#' + r.number + ' ' + r.title).slice(0, 80))
            .join('\n') + (requests.length > 4 ? '\n…' : ''),
          () => open(link),
        );
    },
    reviewChanges(changes: ReviewChange[], acknowledge: (events: ReviewChange[]) => Promise<void>) {
      const grouped = new Map<string, ReviewChange[]>();
      for (const change of changes) {
        const events = grouped.get(change.url) ?? [];
        events.push(change);
        grouped.set(change.url, events);
      }
      for (const [url, events] of grouped) {
        const body = events.map((change) => reviewChangeTitle(change.kind)).join(' · ');
        try {
          port.notify(new URL(url).pathname.slice(1).replace('/pull/', ' #'), body, () => {
            void acknowledge(events)
              .then(() => open(url))
              .catch(() => {
                // The account may have changed since the notification was delivered.
              });
          });
        } catch {
          // The inbox already holds these alerts if the OS cannot show them.
        }
      }
    },
    badge: (count: number) => port.badge(count),
  };
}
export type PrAlerts = ReturnType<typeof prAlerts>;
