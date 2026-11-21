import type { Repository } from '../shared/assistant.js';

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
    badge: (count: number) => port.badge(count),
  };
}
export type PrAlerts = ReturnType<typeof prAlerts>;
