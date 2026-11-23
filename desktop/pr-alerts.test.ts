import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prAlerts } from './pr-alerts.js';

await test('new pull requests raise one notification that opens the first of them', () => {
  const shown: { title: string; body: string; click: () => void }[] = [];
  const badges: number[] = [];
  const opened: string[] = [];
  const alerts = prAlerts(
    {
      notify: (title, body, click) => shown.push({ title, body, click }),
      badge: (count) => badges.push(count),
    },
    (url) => opened.push(url),
  );
  const pull = (number: number, title = 'Guard retries') => ({
    number,
    title,
    author: 'octo',
    approved: false,
    unseen: true,
  });
  alerts.announce('example/project', []);
  assert.equal(shown.length, 0);
  alerts.announce('example/project', [pull(7)]);
  assert.deepEqual(
    [shown[0]?.title, shown[0]?.body],
    ['New pull request in example/project', '#7 Guard retries\n@octo'],
  );
  shown[0]?.click();
  assert.deepEqual(opened, ['https://github.com/example/project/pull/7']);
  alerts.announce(
    'example/project',
    [9, 8, 7, 6, 5].map((n) => pull(n, 'T'.repeat(200))),
  );
  assert.equal(shown[1]?.title, '5 new pull requests in example/project');
  // Long titles and long lists are cut so the notification stays readable.
  assert.deepEqual(
    shown[1]?.body.split('\n').map((line) => line.length),
    [63, 63, 63, 63, 1],
  );
  shown[1]?.click();
  assert.equal(opened.at(-1), 'https://github.com/example/project/pull/9');
  alerts.badge(3);
  assert.deepEqual(badges, [3]);
});

await test('simultaneous push and dismissal open the affected PR from a single system notification', async () => {
  const notices: string[] = [],
    opened: string[] = [];
  const alerts = prAlerts(
    {
      notify(title, body, click) {
        notices.push(title, body);
        click();
      },
      badge() {},
    },
    (url) => opened.push(url),
  );
  const url = 'https://github.com/example/project/pull/7';
  const common = { id: 1, url, head: 'abc', created: '2026-11-23T12:00:00.000Z', unread: true };
  alerts.reviewChanges(
    [
      { ...common, kind: 'dismissed' },
      { ...common, id: 2, kind: 'push' },
    ],
    () => Promise.resolve(),
  );
  await Promise.resolve();
  assert.deepEqual(notices, [
    'example/project #7',
    'Your review was dismissed · New push after your review',
  ]);
  assert.deepEqual(opened, [url]);
});
