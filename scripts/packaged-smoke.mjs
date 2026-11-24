import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const executablePath = process.argv[2];
if (!executablePath) throw new Error('Pass the path to the packaged Local Reviewer executable.');
const profile = await mkdtemp(join(tmpdir(), 'local-reviewer-release-'));
try {
  const app = await electron.launch({
    executablePath,
    args: ['--user-data-dir=' + profile],
    chromiumSandbox: true,
    timeout: 60000,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Pull requests' }).waitFor();
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    await page.getByRole('button', { name: 'Open review', exact: true }).click();
    await page
      .getByLabel('GitHub pull request URL')
      .fill('https://github.com/example/project/pull/1');
    await page.getByRole('button', { name: 'Save pull request' }).click();
    await page.getByRole('button', { name: /#1.*example\/project/ }).waitFor();
    console.log('Packaged app opened and saved a pull request in its isolated SQLite workspace.');
  } finally {
    await app.close();
  }
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
