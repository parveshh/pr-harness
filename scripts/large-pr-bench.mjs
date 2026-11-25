// Measures the reader on a large pull request: `npm run build && npm run bench:large`.
// It drives the built app against a fixture GitHub CLI, like the desktop test, and prints
// medians. Pass `--json` for machine-readable output and `--runs N` to change the sample count.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import electron from 'electron';
import { _electron as launcher } from 'playwright-core';
import { largePr } from '../fixtures/github/large-pr.mjs';

const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const runs = option('--runs', 5);
const shape = {
  files: option('--files', 3000),
  addedLines: option('--added-lines', 50000),
  modifiedRows: option('--modified-rows', 5000),
};
const directory = await mkdtemp(join(tmpdir(), 'local-reviewer-bench-'));
const profile = join(directory, 'profile');
const head = 'c'.repeat(40);
const threads = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
const status = {
  state: 'OPEN',
  headRefOid: head,
  isDraft: false,
  commits: { totalCount: 1 },
  reviewDecision: 'REVIEW_REQUIRED',
  latestOpinionatedReviews: threads,
  latest: { nodes: [] },
  dismissed: { totalCount: 0 },
};
// A read-only GitHub CLI: the large pull request, an account, and empty lists for the rest.
await writeFile(
  join(directory, 'gh'),
  [
    '#!/usr/bin/env node',
    'const { largePrFixture } = require(' +
      JSON.stringify(resolve('fixtures/github/large-pr.mjs')) +
      ');',
    'const argv = process.argv;',
    'const has = (text) => argv.some((arg) => arg.includes(text));',
    "const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? '';",
    'const large = largePrFixture(endpoint, ' + JSON.stringify(shape) + ');',
    "if (argv.includes('POST') || argv.includes('--method')) process.exit(1);",
    "else if (argv.includes('auth')) console.log('fixture-only');",
    'else if (large !== undefined) console.log(JSON.stringify(large));',
    "else if (argv.includes('graphql') && has('reviewThreads('))",
    '  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: ' +
      JSON.stringify(threads) +
      ' } } } }));',
    "else if (argv.includes('graphql') && has('query ReviewStatus'))",
    '  console.log(JSON.stringify({ data: { repository: { pullRequest: ' +
      JSON.stringify(status) +
      ' } } }));',
    "else if (argv.includes('graphql') && has('query ReviewRequests'))",
    "  console.log(JSON.stringify({ data: { viewer: { login: 'fixture-reviewer' }, search: " +
      JSON.stringify(threads) +
      ' } }));',
    "else if (argv.includes('graphql')) process.exit(1);",
    "else if (argv.includes('user')) {",
    "  if (argv.includes('--include')) process.stdout.write('HTTP/2 200 OK\\r\\nDate: ' + new Date().toUTCString() + '\\r\\n\\r\\n');",
    "  console.log(JSON.stringify({ login: 'fixture-reviewer' }));",
    "} else if (endpoint.includes('/actions/runs?')) console.log(JSON.stringify({ total_count: 0, workflow_runs: [] }));",
    "else console.log('[]');",
  ].join('\n'),
  { mode: 0o755 },
);
const env = { ...process.env, PATH: directory + delimiter + process.env.PATH };

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const round = (value) => Math.round(value * 10) / 10;

// Installs `bench.settled` in the page: it resolves with the time since `begin` once `ready`
// holds and two more frames have been produced, so a timing includes rendering and layout.
function install(page) {
  return page.evaluate(() => {
    const frame = () => new Promise((done) => globalThis.requestAnimationFrame(done));
    globalThis.bench = {
      frame,
      async settled(begin, ready) {
        while (!ready()) await frame();
        await frame();
        await frame();
        return globalThis.performance.now() - begin;
      },
    };
  });
}
function chooseFile(page, path) {
  return page.evaluate(async (path) => {
    const { bench, document } = globalThis;
    // A windowed explorer renders the first rows once its list is scrolled to the top.
    document.querySelector('.files-scroll').scrollTop = 0;
    const row = () =>
      Array.from(document.querySelectorAll('button.file-row')).find((button) =>
        button.getAttribute('aria-label').startsWith(path + ','),
      );
    while (!row()) await bench.frame();
    const begin = globalThis.performance.now();
    row().click();
    return bench.settled(
      begin,
      () =>
        document.querySelector('.file-heading h2')?.textContent === path &&
        !!document.querySelector('.diff-scroll .diff-line'),
    );
  }, path);
}
// Scrolls a pane a fixed distance each frame and reports how long the frames took.
function scrollFrames(page, frames, step) {
  return page.evaluate(
    async ([count, distance]) => {
      const pane = globalThis.document.querySelector('[role="region"][aria-label="File diff"]');
      const frame = () => new Promise((done) => globalThis.requestAnimationFrame(done));
      let tasks = 0,
        blocked = 0;
      const observer = new globalThis.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          tasks++;
          blocked += entry.duration;
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      pane.scrollTop = 0;
      await frame();
      await frame();
      const times = [];
      let last = await frame();
      for (let i = 0; i < count; i++) {
        pane.scrollTop += distance;
        const now = await frame();
        times.push(now - last);
        last = now;
      }
      await frame();
      observer.disconnect();
      times.sort((a, b) => a - b);
      const rows = pane.querySelectorAll('.diff-line').length;
      return {
        medianFrame: times[Math.floor(times.length / 2)],
        p95Frame: times[Math.floor(times.length * 0.95)],
        worstFrame: times.at(-1),
        slowFrames: times.filter((time) => time > 50).length,
        longTasks: tasks,
        longTaskTime: blocked,
        scrolledTo: pane.scrollTop,
        renderedRows: rows,
      };
    },
    [frames, step],
  );
}
// Types a filter and waits until the explorer shows files under `shown` and none under `hidden`.
function setFilter(page, text, shown, hidden) {
  return page.evaluate(
    ([text, shown, hidden]) => {
      const { bench, document } = globalThis;
      const input = document.querySelector('input[aria-label="Filter files"]');
      const listed = (prefix) =>
        Array.from(document.querySelectorAll('button.file-row')).some((button) =>
          button.getAttribute('aria-label').startsWith(prefix),
        );
      const begin = globalThis.performance.now();
      Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value').set.call(
        input,
        text,
      );
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
      return bench.settled(begin, () => listed(shown) && !(hidden && listed(hidden)));
    },
    [text, shown, hidden],
  );
}

const results = {};
try {
  const app = await launcher.launch({
    executablePath: electron,
    chromiumSandbox: true,
    env,
    args: ['--user-data-dir=' + profile, '.'],
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(120000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1380, 820));
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1380,
      height: 820,
      deviceScaleFactor: 0,
      mobile: false,
    });
    await install(page);
    await page.getByRole('button', { name: 'Open review', exact: true }).click();
    await page.getByLabel('GitHub pull request URL').fill(largePr.url);
    const cold = Date.now();
    await page.getByRole('button', { name: 'Save pull request' }).click();
    const queueRow = page
      .locator('.pr-queue')
      .getByRole('button', { name: /example\/large|Regenerate routes/ });
    await queueRow.click();
    const region = page.getByRole('region', { name: 'File diff' });
    await region.locator('.diff-line').first().waitFor();
    results.coldOpenMs = Date.now() - cold;
    // Wait for the refresh that follows the cached view, so later timings see a settled reader.
    await page
      .getByRole('button', { name: 'Refresh', exact: true })
      .and(page.locator(':enabled'))
      .waitFor();
    const explorer = page.getByRole('navigation', { name: 'Changed files' });
    await explorer.getByText('of ' + shape.files + ' reviewed').waitFor();

    // Drafts and a published thread on the long modified hunk.
    await chooseFile(page, largePr.modifiedPath);
    await region.locator('.published-threads').getByText(largePr.thread.body).waitFor();
    for (const line of [3, 12, 25]) {
      await region.getByRole('button', { name: 'Draft on new line ' + line, exact: true }).click();
      const editor = region.getByRole('form', { name: 'Draft line comment' });
      await editor.getByLabel('Comment', { exact: true }).fill('Benchmark draft on line ' + line);
      await editor.getByRole('button', { name: 'Save draft' }).click();
      await editor.waitFor({ state: 'detached' });
    }
    assert.equal(await region.locator('.inline-note').count(), 3);

    const samples = {
      openPrMs: [],
      switchToAddedFileMs: [],
      switchToModifiedFileMs: [],
      filterMs: [],
      clearFilterMs: [],
      keystrokeMs: [],
    };
    const scroll = { added: [], modified: [] };
    for (let run = 0; run < runs; run++) {
      // Opening the saved pull request from its queue shows the cached diff of a small file.
      await chooseFile(page, 'packages/pkg-02/src/module-0002.ts');
      await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
      await queueRow.waitFor();
      samples.openPrMs.push(
        await page.evaluate(() => {
          const { bench, document } = globalThis;
          const begin = globalThis.performance.now();
          Array.from(document.querySelectorAll('.pr-queue button'))
            .find((button) => /example\/large|Regenerate routes/.test(button.textContent))
            .click();
          return bench.settled(begin, () => !!document.querySelector('.diff-scroll .diff-line'));
        }),
      );
      await page
        .getByRole('button', { name: 'Refresh', exact: true })
        .and(page.locator(':enabled'))
        .waitFor();
      samples.switchToAddedFileMs.push(await chooseFile(page, largePr.addedPath));
      scroll.added.push(await scrollFrames(page, 120, 900));
      samples.switchToModifiedFileMs.push(await chooseFile(page, largePr.modifiedPath));
      scroll.modified.push(await scrollFrames(page, 120, 300));

      // Typing in the inline editor re-renders the hunk it sits in.
      await region.evaluate((pane) => (pane.scrollTop = 0));
      await region.getByRole('button', { name: 'Draft on new line 20', exact: true }).click();
      const field = region
        .getByRole('form', { name: 'Draft line comment' })
        .getByLabel('Comment', { exact: true });
      await field.waitFor();
      samples.keystrokeMs.push(
        await page.evaluate(async () => {
          const field = globalThis.document.querySelector('#inline-comment-body');
          const frame = () => new Promise((done) => globalThis.requestAnimationFrame(done));
          const set = Object.getOwnPropertyDescriptor(
            globalThis.HTMLTextAreaElement.prototype,
            'value',
          ).set;
          const begin = globalThis.performance.now();
          for (let i = 1; i <= 20; i++) {
            set.call(field, 'x'.repeat(i));
            field.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
            await frame();
          }
          return (globalThis.performance.now() - begin) / 20;
        }),
      );
      await field.press('Escape');
      await field.press('Escape');
      await field.waitFor({ state: 'detached' });

      samples.filterMs.push(await setFilter(page, 'pkg-12/', 'packages/pkg-12/', 'generated/'));
      samples.clearFilterMs.push(await setFilter(page, '', 'generated/', null));
    }
    for (const [name, values] of Object.entries(samples)) results[name] = round(median(values));
    for (const [name, values] of Object.entries(scroll))
      results[name + 'Scroll'] = Object.fromEntries(
        Object.keys(values[0]).map((key) => [
          key,
          round(median(values.map((value) => value[key]))),
        ]),
      );
    results.explorerRows = await explorer.locator('.file-row, .directory-row').count();
    results.domNodes = await page.evaluate(() => globalThis.document.querySelectorAll('*').length);
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (process.argv.includes('--json')) console.log(JSON.stringify({ shape, runs, results }, null, 2));
else {
  const frames = (value) =>
    value.medianFrame +
    ' ms median, ' +
    value.p95Frame +
    ' ms p95, ' +
    value.worstFrame +
    ' ms worst frame; ' +
    value.slowFrames +
    ' of 120 frames over 50 ms; ' +
    value.longTasks +
    ' long tasks (' +
    value.longTaskTime +
    ' ms); ' +
    value.renderedRows +
    ' rows in the DOM';
  console.log(
    [
      'Large PR: ' +
        shape.files +
        ' files, a ' +
        shape.addedLines +
        '-line added file and a ' +
        shape.modifiedRows +
        '-row hunk. Medians of ' +
        runs +
        ' runs.',
      'First fetch to first diff rows (fixture CLI): ' + results.coldOpenMs + ' ms',
      'Open saved PR to first diff rows: ' + results.openPrMs + ' ms',
      'Switch to the ' + shape.addedLines + '-line file: ' + results.switchToAddedFileMs + ' ms',
      'Switch to the ' +
        shape.modifiedRows +
        '-row hunk with drafts and a thread: ' +
        results.switchToModifiedFileMs +
        ' ms',
      'Scroll the ' + shape.addedLines + '-line hunk: ' + frames(results.addedScroll),
      'Scroll the ' + shape.modifiedRows + '-row hunk: ' + frames(results.modifiedScroll),
      'Keystroke in the inline editor: ' + results.keystrokeMs + ' ms',
      'Filter the file explorer: ' +
        results.filterMs +
        ' ms; clear the filter: ' +
        results.clearFilterMs +
        ' ms',
      'Explorer rows in the DOM: ' + results.explorerRows + '; DOM nodes: ' + results.domNodes,
    ].join('\n'),
  );
}
