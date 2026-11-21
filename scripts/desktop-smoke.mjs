import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import electron from 'electron';
import { _electron as launcher } from 'playwright-core';

const live = process.argv.includes('--live');
const directory = await mkdtemp(join(tmpdir(), 'local-reviewer-desktop-'));
const preview = process.env.LOCAL_REVIEWER_PREVIEW_DIR;
async function capture(page, name) {
  if (!preview) return;
  await mkdir(preview, { recursive: true });
  await page.screenshot({ path: join(preview, name + '.png') });
}
const posted = join(directory, 'posted.jsonl');
const profile = join(directory, 'profile');
const repliesFile = join(directory, 'replies.json');
const loginRelease = join(directory, 'login-release');
const signedOut = join(directory, 'signed-out');
const switchedAccount = join(directory, 'switched-account');
const revisionFixture = join(directory, 'revision.json');
const releaseAnswer = join(directory, 'release-answer');
const env = { ...process.env };
if (!live) {
  // Exercise the same gh subprocess contract as production using isolated, repeatable responses.
  const fixture = join(directory, 'review.json');
  const review = JSON.parse(await readFile(resolve('fixtures/github/review.json'), 'utf8'));
  const repository = join(directory, 'source');
  await mkdir(join(repository, 'src'), { recursive: true });
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repository, encoding: 'utf8' },
    ).trim();
  git('init', '--quiet', '--template=');
  const context =
    Array.from({ length: 38 }, (_, i) => 'unchanged caller ' + (i + 2)).join('\n') + '\n';
  await writeFile(join(repository, 'src/reader.ts'), 'old line\n' + context);
  const longLines = Array.from({ length: 860 }, (_, i) => 'fixture row ' + (i + 1));
  await writeFile(join(repository, 'partial.ts'), longLines.join('\n') + '\n');
  git('add', '.');
  git('commit', '-qm', 'before');
  review.meta.base.sha = git('rev-parse', 'HEAD');
  await writeFile(
    join(repository, 'src/reader.ts'),
    'first change\n' +
      context +
      Array.from({ length: 60 }, (_, i) => 'new line ' + (i + 1)).join('\n') +
      '\n',
  );
  longLines[11] = 'updated early';
  longLines[849] = 'updated late';
  await writeFile(join(repository, 'partial.ts'), longLines.join('\n') + '\n');
  review.files.push({
    filename: 'partial.ts',
    status: 'modified',
    additions: 2,
    deletions: 2,
    sha: 'partial',
    patch: '@@ -850 +850 @@\n-fixture row 850\n+updated late',
  });
  review.meta.changed_files = review.files.length;
  git('commit', '-qam', 'after');
  review.meta.head.sha = git('rev-parse', 'HEAD');
  const cache = join(profile, 'pr-source');
  await mkdir(cache, { recursive: true });
  git(
    'clone',
    '--quiet',
    '--bare',
    repository,
    join(cache, createHash('sha256').update('example/project').digest('hex')),
  );
  await writeFile(fixture, JSON.stringify(review));
  env.LOCAL_REVIEWER_FIXTURE_RELEASE = releaseAnswer;
  await writeFile(
    join(directory, 'gh'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'if (fs.existsSync(' + JSON.stringify(join(directory, 'offline')) + ')) process.exit(1);',
      'const response = JSON.parse(fs.readFileSync(' + JSON.stringify(fixture) + ", 'utf8'));",
      'const updatePath = ' + JSON.stringify(revisionFixture) + ';',
      "const update = fs.existsSync(updatePath) ? JSON.parse(fs.readFileSync(updatePath,'utf8')) : null;",
      "if(update){ response.meta.head.sha=update.head; response.meta.base.sha=update.base; response.files[1].patch=response.files[1].patch.replace('+new line 1\\n','+'+update.line+'\\n'); response.files[1].sha=update.line; }",
      // The reviewer counts as having approved once the grouped review has been posted.
      "if(process.argv.includes('graphql') && process.argv.some(a=>a.includes('latestOpinionatedReviews'))){const query=process.argv.find(a=>a.startsWith('query='));const state=fs.existsSync(" +
        JSON.stringify(posted) +
        ")?[{author:{login:'fixture-reviewer'},state:'APPROVED'}]:[];console.log(JSON.stringify({data:{viewer:{login:'fixture-reviewer'},repository:Object.fromEntries([...query.matchAll(/(p\\d+):pullRequest/g)].map(m=>[m[1],{latestOpinionatedReviews:{nodes:m[1]==='p12'?state:[]}}]))}}));return;}",
      // One workflow run that is building until the test marks it finished.
      'const pipelineDone = fs.existsSync(' +
        JSON.stringify(join(directory, 'pipeline-done')) +
        ');',
      "const pipelineStep=(number,name,done)=>({number,name,status:done?'completed':'in_progress',conclusion:done?'success':null,started_at:'2025-01-01T00:00:00Z',completed_at:done?'2025-01-01T00:00:42Z':null});",
      "if(process.argv.some(a=>a.includes('/actions/runs?'))){console.log(JSON.stringify({total_count:1,workflow_runs:[{id:900,name:'Check scaffold',display_title:'Preserve review progress',event:'pull_request',status:pipelineDone?'completed':'in_progress',conclusion:pipelineDone?'success':null,run_attempt:1,run_number:7,workflow_id:70,run_started_at:'2025-01-01T00:00:00Z',html_url:'https://github.com/example/project/actions/runs/900',created_at:'2025-01-01T00:00:00Z',updated_at:'2025-01-01T00:01:05Z'}]}));return;}",
      "if(process.argv.some(a=>a.includes('/actions/runs/900/jobs'))){console.log(JSON.stringify({jobs:[{id:901,name:'check',status:pipelineDone?'completed':'in_progress',conclusion:pipelineDone?'success':null,started_at:'2025-01-01T00:00:00Z',completed_at:pipelineDone?'2025-01-01T00:01:05Z':null,html_url:'https://github.com/example/project/actions/runs/900/job/901',steps:[pipelineStep(1,'Set up job',true),pipelineStep(2,'Run npm test',pipelineDone)]}]}));return;}",
      // Review threads and whether each is resolved.
      'const resolvedFile = ' + JSON.stringify(join(directory, 'resolved')) + ';',
      "if(process.argv.includes('graphql') && process.argv.some(a=>a.includes('ReviewThread('))){const on=process.argv.some(a=>a.includes('mutation($thread:ID!){resolveReviewThread'));if(on)fs.writeFileSync(resolvedFile,'');else if(fs.existsSync(resolvedFile))fs.unlinkSync(resolvedFile);console.log(JSON.stringify({data:{[on?'resolveReviewThread':'unresolveReviewThread']:{thread:{isResolved:on}}}}));return;}",
      "if(process.argv.includes('graphql') && process.argv.some(a=>a.includes('reviewThreads('))){const done=fs.existsSync(resolvedFile);console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{id:'PRRT_fixture56',isResolved:done,viewerCanResolve:!done,viewerCanUnresolve:done,comments:{nodes:[{databaseId:56}]}}]}}}}}));return;}",
      'const repliesFile = ' + JSON.stringify(repliesFile) + ';',
      'const loginRelease = ' + JSON.stringify(loginRelease) + ';',
      'const signedOut = ' + JSON.stringify(signedOut) + ';',
      'const switchedAccount = ' + JSON.stringify(switchedAccount) + ';',
      "if(process.argv.includes('auth') && process.argv.includes('login')){console.error('First copy your one-time code: ABCD-1234'); const timer=setInterval(()=>{if(fs.existsSync(loginRelease)){if(fs.existsSync(signedOut))fs.unlinkSync(signedOut);clearInterval(timer);}},30);return;}",
      "if(process.argv.includes('user') && fs.existsSync(signedOut)){console.error('gh auth login');process.exit(1);}",
      'const threadFile = ' + JSON.stringify(join(directory, 'discussion-replies.jsonl')) + ';',
      "const prior = fs.existsSync(threadFile) ? fs.readFileSync(threadFile,'utf8').trim().split('\\n').map(JSON.parse) : [];",
      "const rootComment = {id:56,user:{login:'alice'},created_at:'2025-01-01T00:00:00Z',body:'Where is the caller tested?',path:'src/reader.ts',line:1,side:'RIGHT'};",
      "if(process.argv.some(a=>a.endsWith('/comments/56/replies') || a.endsWith('/issues/12/comments')) && process.argv.includes('POST')) {const inline=process.argv.some(a=>a.endsWith('/replies'));const row={...rootComment,id:1000+prior.length, user:{login:'fixture-reviewer'},body:JSON.parse(fs.readFileSync(0,'utf8')).body,in_reply_to_id:inline?56:null};if(row.body.startsWith('Undelivered fixture.'))process.exit(1);fs.appendFileSync(threadFile,JSON.stringify(row)+'\\n');if(row.body.startsWith('Lost receipt fixture.'))process.exit(1);if(row.body.startsWith('Refresh during reply.')){setTimeout(()=>console.log(JSON.stringify(row)),800);return;}console.log(JSON.stringify(row));return;}",
      "if(process.argv.some(a=>a.includes('/pulls/12/comments?per_page='))) {console.log(JSON.stringify([rootComment,{...rootComment,id:91,path:'partial.ts',body:'Earlier omitted line?',line:12},{...rootComment,id:92,path:'partial.ts',body:'Later visible line?',line:850,side:'LEFT'},...prior.filter(r=>r.in_reply_to_id)]));return;}",
      "if(process.argv.some(a=>a.includes('/issues/12/comments?'))) {console.log(JSON.stringify([{...rootComment,id:61,path:null,body:'Is this ready to ship?'},...prior.filter(r=>!r.in_reply_to_id)].map(({path,...row})=>row)));return;}",
      "if(process.argv.some(arg=>arg.includes('/comments?'))){console.log(fs.existsSync(repliesFile)?fs.readFileSync(repliesFile,'utf8'):'[]');return;}",
      "if(process.argv.includes('auth') && process.argv.includes('token')){if(fs.existsSync(signedOut))process.exit(1);console.log('fixture-only');return;}",
      "if(process.argv.includes('user') && process.argv.includes('--include')){process.stdout.write('HTTP/2 200 OK\\r\\nDate: '+new Date().toUTCString()+'\\r\\n\\r\\n');}",
      'const posted = ' + JSON.stringify(posted) + ';',
      "if(process.argv.includes('user')) { if(fs.existsSync(switchedAccount)) setTimeout(()=>console.log(JSON.stringify({login:'second-reviewer'})),250); else console.log(JSON.stringify({login:'fixture-reviewer'})); }",
      "else if(process.argv.includes('POST')) { const payload=JSON.parse(fs.readFileSync(0,'utf8')); fs.appendFileSync(posted,JSON.stringify(payload)+'\\n'); process.exit(1); }",
      "else if(process.argv.some(a=>a.includes('/reviews?'))) { if(!fs.existsSync(posted)){console.log('[]');return;} const payload=JSON.parse(fs.readFileSync(posted,'utf8').trim()); console.log(JSON.stringify([{id:75,body:payload.body,commit_id:payload.commit_id,state:'COMMENTED',user:{login:'fixture-reviewer'}}])); }",
      "else if(process.argv.some(a=>a.includes('/contributors?'))) console.log(JSON.stringify([{login:'octo'},{login:'other'}]));",
      // A second pull request is opened once the test asks for it.
      "else if(process.argv.some(a=>a.includes('/issues?'))) console.log(JSON.stringify([{number:12,title:'Tracked PR',user:{login:'octo'},pull_request:{}},...(fs.existsSync(" +
        JSON.stringify(join(directory, 'new-pr')) +
        ")?[{number:14,title:'Fresh PR',user:{login:'octo'},pull_request:{}}]:[])]));",
      "else if(process.argv.some(a=>a.includes('/pulls?'))) console.log(JSON.stringify([{number:12,title:'Tracked PR',user:{login:'octo'}},{number:13,title:'Other PR',user:{login:'other'}}]));",
      "else if(process.argv.some(a=>a.includes('/compare/'))) { const from=process.argv.find(a=>a.includes('/compare/')).split('/compare/')[1].split('...')[0]; console.log(JSON.stringify({status:update?.rewrite?'diverged':'ahead',merge_base_commit:{sha:from},files:update?[{...response.files[1],additions:1,deletions:1,patch:'@@ -40 +40 @@\\n-new line 1\\n+'+update.line}]:[]})); }",
      "else if(process.argv.includes('Accept: application/vnd.github.diff')) process.stdout.write(response.raw);",
      "else process.stdout.write(JSON.stringify(process.argv.some(a=>a.includes('/files?')) ? response.files : response.meta));",
    ].join('\n'),
    { mode: 0o755 },
  );
  for (const id of ['codex', 'claude']) {
    await writeFile(join(directory, id), await readFile(resolve('fixtures/agents/mock-cli.mjs')), {
      mode: 0o755,
    });
  }
  env.PATH = directory + delimiter + env.PATH;
}
const url = live
  ? 'https://github.com/octocat/Hello-World/pull/1'
  : 'https://github.com/example/project/pull/12';
const launch = () =>
  launcher.launch({
    executablePath: electron,
    chromiumSandbox: true,
    env,
    args: ['--user-data-dir=' + profile, '.'],
  });
// macOS clamps a window to the screen, and a small CI display would switch the reader to
// its narrow layout. Pin the viewport as well so the layout under test matches the request.
const sessions = new WeakMap();
async function resize(app, page, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
    { width, height },
  );
  // The override lasts only while its session stays attached.
  let session = sessions.get(page);
  if (!session) sessions.set(page, (session = await page.context().newCDPSession(page)));
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false,
  });
}
// The harness and model are chosen once, in the title bar, for the whole app.
async function chooseHarness(page, { agent, model }) {
  await page.getByRole('button', { name: /^Harness and model: / }).click();
  const form = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  if (agent) await form.getByLabel('Harness', { exact: true }).selectOption(agent);
  await form.getByLabel('Model', { exact: true }).fill(model);
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: new RegExp('^Harness and model: .* · ' + model + '$') })
    .waitFor();
}
let restoredFilesWidth;
try {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await resize(app, page, 1380, 720);
    await page.getByText('Your first review starts here').waitFor();
    await capture(page, 'workspace');
    if (!live) {
      await writeFile(signedOut, '');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settingsPane = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settingsPane.getByRole('button', { name: 'Connect account' }).press('Enter');
      await settingsPane.getByText('ABCD-1234', { exact: true }).waitFor();
      await writeFile(loginRelease, '');
      await settingsPane.getByText('@fixture-reviewer', { exact: true }).waitFor();
      await settingsPane.getByLabel('Interface font').selectOption('humanist');
      await settingsPane.getByText('Large', { exact: true }).click();
      await settingsPane.getByText('Midnight', { exact: true }).click();
      await page.waitForFunction(
        () =>
          globalThis.document.documentElement.dataset.palette === 'midnight' &&
          globalThis.document.documentElement.dataset.font === 'humanist' &&
          globalThis.document.documentElement.dataset.textSize === 'large',
      );
      await capture(page, 'settings');
      // Every theme is chosen in Settings, the only place it can be changed.
      for (const [name, id] of [
        ['Smoked Bronze', 'bronze'],
        ['Titanium', 'titanium'],
        ['Graphite', 'graphite'],
        ['Forest', 'forest'],
        ['Aubergine', 'aubergine'],
        ['Arctic', 'arctic'],
        ['Rosewood', 'rosewood'],
        ['Petrol', 'petrol'],
        ['Ink', 'ink'],
      ]) {
        await settingsPane.getByText(name, { exact: true }).click();
        await page.waitForFunction(
          (palette) => globalThis.document.documentElement.dataset.palette === palette,
          id,
        );
      }
      for (const [name, id] of [
        ['Blue', 'blue'],
        ['Neutral', 'neutral'],
        ['Violet', 'violet'],
      ]) {
        await settingsPane.getByText(name, { exact: true }).click();
        await page.waitForFunction(
          (accent) => globalThis.document.documentElement.dataset.accent === accent,
          id,
        );
        // Neutral gives back the theme's own control colour.
        if (id === 'neutral')
          assert.equal(
            await page.evaluate(() =>
              globalThis
                .getComputedStyle(globalThis.document.documentElement)
                .getPropertyValue('--control')
                .trim(),
            ),
            '#d4d9d8',
          );
      }
      // The accent recolours the primary controls, not only the swatch.
      assert.equal(
        await page.evaluate(() =>
          globalThis
            .getComputedStyle(globalThis.document.documentElement)
            .getPropertyValue('--control')
            .trim(),
        ),
        '#b8a8f5',
      );
      await capture(page, 'accent');
      await settingsPane.getByText('Default', { exact: true }).click();
      await settingsPane.getByRole('button', { name: 'Close' }).click();
      assert.equal(await page.getByRole('button', { name: /^Appearance/ }).count(), 0);
    }
    if (process.platform === 'darwin') {
      const pos = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getWindowButtonPosition(),
      );
      assert.deepEqual(pos, { x: 14, y: 19 });
      const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
      const pinned = await collapse.boundingBox();
      assert.ok(pinned && pinned.y < 25);
      await collapse.click();
      const expand = page.getByRole('button', { name: 'Expand sidebar' });
      assert.deepEqual(await expand.boundingBox(), pinned);
      await expand.click();
    }
    if (!live) {
      const trigger = page.getByRole('button', { name: 'Add repository', exact: true });
      await trigger.focus();
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Add repository' });
      await dialog.getByLabel('Repository', { exact: true }).fill('not-a-repo');
      await dialog.getByRole('button', { name: 'Add repository' }).click();
      await dialog.getByRole('alert').waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await trigger.and(page.locator(':focus')).waitFor();
    }
    if (!live)
      await page.evaluate(() =>
        globalThis.localStorage.setItem('react-resizable-panels:review-layout', 'invalid'),
      );
    await page.getByLabel('GitHub pull request URL').fill(url);
    await page.getByRole('button', { name: 'Save pull request' }).click();
    await page
      .getByRole('button', { name: live ? /octocat\/hello-world/ : /example\/project/ })
      .click();
    const region = page.getByRole('region', { name: 'File diff' });
    await region.waitFor({ timeout: 45000 });
    assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
    if (!live) {
      await page.getByRole('button', { name: 'Add repository', exact: true }).click();
      await page.getByLabel('Repository', { exact: true }).fill('example/project');
      await capture(page, 'add-repository');
      await page
        .getByRole('dialog', { name: 'Add repository' })
        .getByRole('button', { name: 'Add repository' })
        .click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('checkbox', { name: 'octo', exact: true }).check();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      const sidebar = page.getByRole('complementary', { name: 'Repository sidebar' });
      await sidebar.getByRole('button', { name: /Tracked PR/ }).click();
      assert.equal(await sidebar.getByRole('button', { name: /Other PR/ }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'PR discussions' }).count(), 0);
      await page.getByRole('button', { name: /^src\/reader\.ts, modified/ }).click();
      const discussions = page.locator('details.pr-conversation');
      await discussions.locator('summary').click();
      const discussionThread = page
        .locator('.diff-scroll .published-threads [role="article"]')
        .filter({ hasText: 'Where is the caller tested?' });
      await discussionThread.waitFor();
      assert.equal(
        await discussionThread.evaluate(
          (el) => el.parentElement.previousElementSibling.dataset.newLine,
        ),
        '1',
      );
      await page.getByRole('button', { name: 'Full file', exact: true }).click();
      const fullFile = page.getByRole('region', { name: 'Full file with changes' });
      await fullFile.getByText('unchanged caller 12', { exact: true }).waitFor();
      await fullFile.locator('.deletion').getByText('-old line').waitFor();
      await fullFile.locator('.addition').getByText('+first change').waitFor();
      await discussionThread.getByRole('button', { name: 'Reply', exact: true }).click();
      await discussionThread.getByRole('textbox').fill('See the caller integration test.');
      await discussionThread.getByRole('button', { name: 'Post reply to GitHub' }).click();
      await discussionThread.getByText('See the caller integration test.').waitFor();
      await page.getByRole('button', { name: 'Diff only', exact: true }).click();
      await discussionThread.getByText('See the caller integration test.').waitFor();
      // A review thread can be resolved on GitHub from its place in the diff, and reopened.
      await discussionThread
        .getByRole('button', { name: 'Resolve conversation', exact: true })
        .click();
      await discussionThread.getByText('Resolved', { exact: true }).waitFor();
      assert.equal(await discussionThread.getAttribute('data-resolved'), 'true');
      await discussionThread
        .getByRole('button', { name: 'Reopen conversation', exact: true })
        .click();
      await discussionThread
        .getByRole('button', { name: 'Resolve conversation', exact: true })
        .waitFor();
      assert.equal(await discussionThread.getByText('Resolved', { exact: true }).count(), 0);
      // The pipeline view follows the run for the commit under review down to its steps.
      await page.getByRole('button', { name: 'Pipeline: Running', exact: true }).click();
      const pipelineView = page.getByRole('dialog', { name: 'Pipeline', exact: true });
      const pipelineRun = pipelineView.getByRole('region', { name: 'Check scaffold run 7' });
      await pipelineRun.getByText('Running · pull_request · run #7', { exact: true }).waitFor();
      const testStep = pipelineRun.getByRole('listitem').filter({ hasText: 'Run npm test' });
      await testStep.getByText('Running', { exact: true }).waitFor();
      await capture(page, 'pipeline');
      await writeFile(join(directory, 'pipeline-done'), '');
      await pipelineView.getByRole('button', { name: 'Refresh' }).click();
      await pipelineRun
        .getByText('Passed · pull_request · run #7 · 1m 5s', { exact: true })
        .waitFor();
      await pipelineView.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'Pipeline: Passed', exact: true }).waitFor();
      const general = discussions
        .getByRole('article')
        .filter({ hasText: 'Is this ready to ship?' });
      await general.getByRole('button', { name: 'Reply', exact: true }).click();
      await general.getByRole('textbox').fill('Ready after CI.');
      await general.getByRole('button', { name: 'Post reply to GitHub' }).click();
      await discussions.getByText('Ready after CI.').waitFor();
      await discussions.getByRole('button', { name: 'Refresh discussions' }).click();
      await discussions.getByRole('button', { name: 'Refresh discussions' }).click({ trial: true });
      await discussionThread.getByText('See the caller integration test.').waitFor();
      assert.equal(
        await discussions
          .getByRole('link', { name: 'In reply to this comment' })
          .getAttribute('href'),
        url + '#issuecomment-61',
      );
      await discussionThread.getByRole('button', { name: 'Reply', exact: true }).click();
      await discussionThread.getByRole('textbox').fill('Refresh during reply.');
      await discussionThread.getByRole('button', { name: 'Post reply to GitHub' }).click();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await discussionThread.getByText('Refresh during reply.', { exact: true }).waitFor();
      await discussionThread.getByRole('button', { name: 'Reply', exact: true }).click();
      await discussionThread.getByRole('textbox').fill('Lost receipt fixture.');
      await discussionThread.getByRole('button', { name: 'Post reply to GitHub' }).click();
      await discussions.getByRole('alert').filter({ hasText: 'did not confirm' }).waitFor();
      await discussions.getByRole('button', { name: 'Refresh discussions' }).click();
      await discussionThread.getByText('Lost receipt fixture.', { exact: true }).waitFor();
      assert.equal(await discussionThread.getByText(/Delivery is unconfirmed/).count(), 0);
      await discussionThread.getByRole('button', { name: 'Reply', exact: true }).click();
      assert.equal(await discussionThread.getByRole('textbox').inputValue(), '');
      await discussionThread.getByRole('textbox').fill('Undelivered fixture.');
      await discussionThread.getByRole('button', { name: 'Post reply to GitHub' }).click();
      await discussions.getByRole('alert').filter({ hasText: 'did not confirm' }).waitFor();
      await discussions.getByRole('button', { name: 'Refresh discussions' }).click();
      await discussionThread.getByRole('button', { name: 'Discard local attempt' }).click();
      await discussionThread.getByRole('button', { name: 'Reply', exact: true }).click();
      assert.equal(await discussionThread.getByRole('textbox').inputValue(), '');
      await discussionThread.getByRole('textbox').fill('Private unsent draft');
      await writeFile(switchedAccount, '');
      await discussions.getByRole('button', { name: 'Refresh discussions' }).click();
      await discussions.getByText('@second-reviewer', { exact: true }).waitFor();
      await discussionThread.getByRole('button', { name: 'Reply', exact: true }).click();
      assert.equal(await discussionThread.getByRole('textbox').inputValue(), '');
      await page.evaluate(
        (key) => globalThis.localStorage.setItem(key, 'malformed-fixture'),
        'discussion-replies:' + url + ':second-reviewer',
      );
      await discussions.getByRole('button', { name: 'Refresh discussions' }).click();
      await discussions.getByRole('alert').filter({ hasText: 'recovery record' }).waitFor();
      await general.getByText('Is this ready to ship?').waitFor();
      await discussions.getByRole('button', { name: 'Clear local reply tracking' }).click();
      await discussionThread
        .getByRole('button', { name: 'Reply', exact: true })
        .click({ trial: true });
      await rm(switchedAccount);
      // Each file shows how many published comments it has.
      const partialRow = page.getByRole('button', {
        name: 'partial.ts, modified, 2 comments',
        exact: true,
      });
      assert.equal(await partialRow.locator('.file-comments').innerText(), '2');
      assert.equal(
        await page
          .getByRole('button', { name: /^README\.md, added/ })
          .locator('.file-comments')
          .count(),
        0,
      );
      await partialRow.click();
      const oldQuestion = page
        .locator('.published-threads [role="article"]')
        .filter({ hasText: 'Later visible line?' });
      await oldQuestion.waitFor();
      await discussions.getByText('Earlier omitted line?').waitFor();
      assert.equal(await page.getByText('Later visible line?', { exact: true }).count(), 1);
      assert.equal(
        await oldQuestion.evaluate((el) => el.parentElement.previousElementSibling.dataset.oldLine),
        '850',
      );
      await page.getByRole('button', { name: 'Select old line 850', exact: true }).click();
      await page.getByRole('button', { name: 'Full file', exact: true }).click();
      await page.getByText('Page 3 of 3', { exact: true }).waitFor();
      await oldQuestion.waitFor();
      await page.getByRole('button', { name: 'Previous page' }).click();
      await discussions.getByText('Later visible line?').waitFor();
      await page.getByRole('button', { name: 'Diff only', exact: true }).click();
      await discussions.locator('summary').click();
      await page.getByRole('button', { name: 'README.md, added', exact: true }).click();
      const chat = page.getByRole('region', { name: 'Review chat' });
      const files = page.getByRole('navigation', { name: 'Changed files' });
      const fileWidth = () => files.evaluate((el) => el.clientWidth);
      const railDivider = page.getByRole('separator', { name: 'Resize repository sidebar' });
      const sidebarWidth = await sidebar.evaluate((el) => el.clientWidth);
      await railDivider.press('ArrowRight');
      assert.ok((await sidebar.evaluate((el) => el.clientWidth)) > sidebarWidth);
      await railDivider.press('ArrowLeft');
      const before = await fileWidth();
      const divider = page.getByRole('separator', { name: 'Resize files and diff' });
      const box = await divider.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 52, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      assert.ok((await fileWidth()) > before + 30);
      const chatDivider = page.getByRole('separator', { name: 'Resize diff and chat' });
      const chatBefore = await chat.evaluate((el) => el.clientWidth);
      await chatDivider.press('ArrowLeft');
      assert.ok((await chat.evaluate((el) => el.clientWidth)) > chatBefore);
      restoredFilesWidth = await fileWidth();
      await resize(app, page, 850, 720);
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await resize(app, page, 850, 440);
      await chat.getByLabel('Context', { exact: true }).selectOption('full-pr');
      await chat.getByLabel('Ask about the diff').fill('Keep my question');
      await chat.getByRole('button', { name: 'Send', exact: true }).scrollIntoViewIfNeeded();
      await chat.getByRole('button', { name: 'Send', exact: true }).click({ trial: true });
      assert.equal(await divider.isVisible(), false);
      await page.getByRole('button', { name: 'Diff', exact: true }).click();
      await region.waitFor();
      await resize(app, page, 1380, 720);
      await divider.waitFor();
      assert.equal(await chat.getByLabel('Ask about the diff').inputValue(), 'Keep my question');
      await chat.getByLabel('Ask about the diff').fill('');

      await page.getByRole('button', { name: 'Select new line 1', exact: true }).click();
      await chat.getByRole('button', { name: 'Review instructions', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Review instructions', exact: true });
      await settings
        .getByLabel('Review prompt')
        .fill('Check the before and after behaviour with citations.');
      await settings.getByLabel('Save instructions for').selectOption('review');
      await settings.getByRole('button', { name: 'Close' }).click();
      assert.equal(await chat.getByLabel('Model', { exact: true }).count(), 0);
      await chooseHarness(page, { model: 'fixture-model' });
      await chat.getByRole('button', { name: 'Explain file' }).click();
      await chat
        .getByText(
          'Explain this new file. What does it introduce, how does it work, and how does it fit into this PR?',
          { exact: true },
        )
        .waitFor();
      const answer = chat.locator('.chat-answer').first();
      await answer.getByRole('heading', { name: 'Review notes' }).waitFor();
      assert.equal(await answer.locator('li strong').innerText(), 'Selected change');
      assert.equal(await answer.locator('pre code').innerText(), 'const literal = "[[1]]";\n');
      assert.equal(await answer.getByRole('cell', { name: 'Scope' }).count(), 1);
      assert.equal(
        await answer.getByRole('link', { name: 'Documentation' }).getAttribute('href'),
        'https://example.com/docs',
      );
      assert.equal(await answer.locator('img, pre button').count(), 0);
      await chat.locator('.cite').last().click();
      await page.getByRole('heading', { name: 'src/reader.ts' }).waitFor();
      await page.locator('.diff-line[data-selected="true"]').waitFor();
      await capture(page, 'review-chat');
      await chooseHarness(page, { agent: 'claude', model: 'invalid-model' });
      await chat.getByLabel('Ask about the diff').fill('Compare with the caller');
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await chat.getByRole('alert').filter({ hasText: /model/i }).waitFor();
      await chooseHarness(page, { model: 'fixture-model' });
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await chat.getByText(/claude · fixture-model/).waitFor();
      assert.equal(
        await chat.getByText('Read from the local PR copy.', { exact: true }).count(),
        2,
      );
      await chat.getByLabel('Context', { exact: true }).selectOption('focused');
      await chat.getByLabel('Ask about the diff').fill('Half-typed question');
      await chat.getByRole('button', { name: 'Summarise PR', exact: true }).click();
      const summary = chat
        .locator('.exchange')
        .filter({ hasText: 'Summarise this whole pull request.' });
      await summary.first().getByText('Read from the local PR copy.', { exact: true }).waitFor();
      await summary
        .first()
        .getByText(/claude · fixture-model · \w+ · Full PR/)
        .waitFor();
      assert.equal(await chat.getByLabel('Context', { exact: true }).inputValue(), 'focused');
      assert.equal(await chat.getByLabel('Ask about the diff').inputValue(), 'Half-typed question');
      // The same summary and an approval can be started from the PR's row in the sidebar.
      const trackedRow = page
        .getByRole('complementary', { name: 'Repository sidebar' })
        .locator('.monitored-pr');
      await trackedRow
        .getByRole('button', { name: 'Summarise pull request #12', exact: true })
        .click();
      await summary.nth(1).getByText('Read from the local PR copy.', { exact: true }).waitFor();
      // A new answer is scrolled into view.
      await page.waitForFunction(() => {
        const log = globalThis.document.querySelector('.chat-log');
        return log && log.scrollHeight - log.scrollTop - log.clientHeight < 4;
      });
      assert.equal(await trackedRow.getAttribute('data-approved'), null);
      await trackedRow
        .getByRole('button', { name: 'Approve pull request #12', exact: true })
        .click();
      const decision = page.getByLabel('Review decision');
      assert.equal(await decision.inputValue(), 'APPROVE');
      await page.keyboard.press('Escape');
      await decision.waitFor({ state: 'hidden' });
      await chat.getByLabel('Ask about the diff').fill('Wait for cancellation');
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await chat.getByText('Waiting for cancellation', { exact: true }).waitFor();
      await chat.getByText(/Working on an answer · \d+s/).waitFor();
      // The answer belongs to its PR: it keeps running, and the sidebar says so, while the
      // reviewer is elsewhere, and its progress is there again on return.
      const working = trackedRow.getByRole('status', {
        name: 'Answering a question in pull request #12',
        exact: true,
      });
      await working.waitFor();
      await page.getByRole('button', { name: 'Workspace', exact: true }).click();
      await page.getByRole('heading', { name: 'Review workspace' }).waitFor();
      await working.waitFor();
      await trackedRow.getByRole('button', { name: /Tracked PR/ }).click();
      await chat.getByText('Waiting for cancellation', { exact: true }).waitFor();
      assert.equal(
        await chat.getByLabel('Ask about the diff').inputValue(),
        'Wait for cancellation',
      );
      await chat.getByRole('button', { name: 'Cancel', exact: true }).click();
      await chat
        .getByRole('alert')
        .filter({ hasText: /cancelled/i })
        .waitFor();
      await working.waitFor({ state: 'detached' });
      // An answer that arrives while another screen is open is saved to its own PR and is
      // in that PR's chat on return.
      await chat.getByLabel('Ask about the diff').fill('Answer while away');
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await chat.getByText('Still working', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Workspace', exact: true }).click();
      await page.getByRole('heading', { name: 'Review workspace' }).waitFor();
      await working.waitFor();
      await writeFile(releaseAnswer + '-away', '');
      await working.waitFor({ state: 'detached' });
      await trackedRow.getByRole('button', { name: /Tracked PR/ }).click();
      const away = chat.locator('.exchange').filter({ hasText: 'Answer while away' });
      await away.getByRole('heading', { name: 'Review notes' }).waitFor();
      assert.equal(await away.count(), 1);
      assert.equal(await chat.getByLabel('Ask about the diff').inputValue(), '');
      assert.equal(await chat.getByRole('alert').count(), 0);
      await page.getByRole('button', { name: /logo\.png/ }).click();
      await page.getByText('Binary file. A line diff is unavailable.').waitFor();
      await page.getByRole('button', { name: /new name\.txt/ }).click();
      await page.getByText('old name.txt', { exact: true }).waitFor();
      await page
        .getByRole('navigation')
        .getByRole('button', { name: /src\/reader\.ts/ })
        .click();
      for (const [side, body] of [
        ['old', 'Deleted line note'],
        ['new', 'Added line note'],
      ]) {
        await page
          .getByRole('button', { name: 'Draft on ' + side + ' line 1', exact: true })
          .click();
        await page.getByLabel('Comment', { exact: true }).fill(body);
        await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      }
      await page.getByRole('button', { name: 'Edit draft on old line 1' }).click();
      await page.getByLabel('Comment', { exact: true }).fill('Edited deletion note');
      await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      await page.getByRole('button', { name: 'Comment on line', exact: true }).click();
      await page.getByLabel('Comment', { exact: true }).fill('Discard this draft');
      await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      await page.getByRole('button', { name: /Review drafts 3/ }).click();
      await page
        .locator('.draft-card')
        .filter({ hasText: 'Discard this draft' })
        .getByRole('button', { name: 'Discard' })
        .click();
      await page.getByLabel('Review summary').fill('Grouped review summary');
      await page.getByRole('button', { name: 'Save and close' }).click();
      await page.getByRole('button', { name: 'Next hunk' }).click();
      await region.getByText('+new line 60', { exact: true }).waitFor({ state: 'attached' });
      await page.getByRole('button', { name: 'Select new line 42', exact: true }).click();
      await page
        .getByRole('button', { name: 'Select new line 40', exact: true })
        .click({ modifiers: ['Shift'] });
      assert.equal(await region.locator('.diff-line[data-selected=true]').count(), 3);
      await page.getByRole('button', { name: 'Comment on lines 40–42' }).click();
      const inline = region.getByRole('form', { name: 'Draft line comment' });
      await inline.getByRole('button', { name: 'Cancel', exact: true }).click();
      for (const [from, to] of [
        [43, 45],
        [42, 40],
      ]) {
        const icon = region.getByRole('button', { name: 'Draft on new line ' + from, exact: true });
        await icon.scrollIntoViewIfNeeded();
        const start = await icon.boundingBox();
        const end = await region
          .getByRole('button', { name: 'Draft on new line ' + to, exact: true })
          .boundingBox();
        assert.ok(start && end);
        await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 5 });
        await page.mouse.up();
        await inline
          .getByText(new RegExp(Math.min(from, to) + '[–-]' + Math.max(from, to)))
          .waitFor();
        if (from === 43) await inline.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      const focusStyle = await inline
        .getByLabel('Comment', { exact: true })
        .evaluate((el) => globalThis.getComputedStyle(el).outlineWidth);
      assert.equal(focusStyle, '1px');
      await capture(page, 'block-comment');

      await inline.getByLabel('Comment', { exact: true }).fill('Check this range together.');
      await inline.getByRole('button', { name: 'Save draft' }).click();
      await region.getByText('Check this range together.', { exact: true }).waitFor();
      await capture(page, 'inline-range');
      await page.getByRole('button', { name: 'Pin question', exact: true }).click();
      const composer = page.getByRole('dialog', { name: 'Pin a question' });
      await composer
        .getByLabel('Question', { exact: true })
        .fill('Could concurrent retries bypass this guard?');
      await composer.getByRole('button', { name: 'Save pinned question' }).click();
      await page
        .getByRole('button', { name: 'Could concurrent retries bypass this guard?', exact: true })
        .waitFor();

      await region.evaluate((el) => {
        el.scrollTop = 160;
      });
      await page.waitForFunction(async () => {
        const view = await globalThis.reviewer.cachedReview(
          'https://github.com/example/project/pull/12',
        );
        return view.files.some((file) => file.path === 'src/reader.ts' && file.scroll === 160);
      });
    }
    if (!live) {
      await region.and(page.locator('[data-scrolling=true]')).waitFor();
      await page.waitForFunction(
        () => !globalThis.document.querySelector('.diff-scroll[data-scrolling]'),
      );
      assert.equal(await page.evaluate(() => globalThis.scrollY), 0);
    }
    await page.getByRole('button', { name: 'Mark reviewed' }).click();
    await page.getByRole('button', { name: 'Reviewed ✓' }).waitFor();
  } finally {
    await app.close();
  }
  if (!live) await writeFile(join(directory, 'offline'), '');
  const reopened = await launch();
  try {
    const page = await reopened.firstWindow();
    await resize(reopened, page, 1380, 720);
    if (!live) {
      const files = page.getByRole('navigation', { name: 'Changed files' });
      await files.waitFor();
      assert.ok(Math.abs((await files.evaluate((el) => el.clientWidth)) - restoredFilesWidth) < 3);
      await page.getByRole('heading', { name: 'Review notes' }).first().waitFor();
      // The harness and model chosen before the restart still apply.
      await page
        .getByRole('button', {
          name: 'Harness and model: Claude Code · fixture-model',
          exact: true,
        })
        .waitFor();
    }
    await page.getByRole('button', { name: 'Reviewed ✓' }).waitFor();
    const region = page.getByRole('region', { name: 'File diff' });
    await region.waitFor();
    if (!live) {
      // The theme and font chosen in Settings survive the restart.
      assert.deepEqual(
        await page.evaluate(() => {
          const { palette, accent, font } = globalThis.document.documentElement.dataset;
          return { palette, accent, font };
        }),
        { palette: 'ink', accent: 'violet', font: 'humanist' },
      );
      await page
        .getByText(/claude · fixture-model.*Full PR/)
        .first()
        .waitFor();
      await page.getByRole('button', { name: /Tracked PR/ }).waitFor();
      assert.equal(
        await page.getByRole('region', { name: 'Review chat' }).locator('.exchange').count(),
        5,
      );
      await page.getByText('Hunk 2 of 2').waitFor();
      await page
        .getByRole('button', { name: 'Could concurrent retries bypass this guard?', exact: true })
        .waitFor();
      await page.getByRole('heading', { name: 'src/reader.ts' }).waitFor();
      await page.getByText(/Showing the saved revision/).waitFor();
      assert.equal(await region.evaluate((el) => el.scrollTop), 160);
      await page.getByRole('button', { name: /Review drafts 3/ }).click();
      await page.getByRole('dialog').getByText('Edited deletion note', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Review summary').inputValue(), 'Grouped review summary');
      await rm(join(directory, 'offline'));
      await page.getByRole('button', { name: 'Preview submission' }).click();
      await page.getByText('@fixture-reviewer').waitFor();
      await capture(page, 'review-preview');
      // Record notifications instead of showing them on the desktop running the test.
      await reopened.evaluate(({ Notification }) => {
        globalThis.shownAlerts = [];
        Notification.prototype.show = function show() {
          globalThis.shownAlerts.push(this.title + '|' + this.body);
        };
      });
      await writeFile(join(directory, 'new-pr'), '');
      await page.getByRole('button', { name: 'Submit review to GitHub', exact: true }).click();
      await page.getByRole('button', { name: 'Check GitHub', exact: true }).click();
      await page.getByRole('button', { name: /Open published review/ }).waitFor();
      // Publishing refreshes the sidebar, which marks the PR as approved by this reviewer.
      const approvedRow = page.locator('.monitored-pr[data-approved]');
      await approvedRow.waitFor();
      await approvedRow
        .getByRole('button', { name: 'Approved. Review pull request #12', exact: true })
        .waitFor();
      // A pull request that appeared since the last check is highlighted, announced once,
      // and counted on the app icon until it is opened.
      const freshRow = page.locator('.monitored-pr[data-new]');
      await freshRow.getByRole('button', { name: /Fresh PR/ }).waitFor();
      await freshRow.getByText('New', { exact: true }).waitFor();
      assert.deepEqual(await reopened.evaluate(() => globalThis.shownAlerts), [
        'New pull request in example/project|#14 Fresh PR\n@octo',
      ]);
      if (process.platform !== 'win32')
        assert.equal(await reopened.evaluate(({ app }) => app.getBadgeCount()), 1);
      const payload = JSON.parse((await readFile(posted, 'utf8')).trim());
      assert.deepEqual(
        payload.comments.map((c) => [c.side, c.line, c.body]),
        [
          ['LEFT', 1, 'Edited deletion note'],
          ['RIGHT', 1, 'Added line note'],
          ['RIGHT', 42, 'Check this range together.'],
        ],
      );
      assert.equal(payload.comments[2].start_line, 40);
      assert.equal(payload.comments[2].start_side, 'RIGHT');
      assert.equal(payload.event, 'COMMENT');
      await page.getByRole('button', { name: /Review drafts 0/ }).waitFor();
      const chat = page.getByRole('region', { name: 'Review chat' });
      await page.getByRole('button', { name: 'Draft on new line 40', exact: true }).click();
      await page.getByLabel('Comment', { exact: true }).fill('Check the original retry.');
      await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      await chat.getByLabel('Ask about the diff').fill('Answer after the push');
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await chat.getByText('Holding the original revision', { exact: true }).waitFor();
      const base = JSON.parse(await readFile(join(directory, 'review.json'), 'utf8')).meta.base.sha;
      const second = { base, head: 'c'.repeat(40), line: 'guard retries' };
      await writeFile(revisionFixture, JSON.stringify(second));
      await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('focus')));
      await page.getByRole('button', { name: 'Open update' }).waitFor();
      await page.getByRole('button', { name: 'Reviewed ✓' }).waitFor();
      await page.getByText('Hunk 2 of 2').waitFor();
      await page.getByRole('button', { name: 'Open update' }).click();
      const delta = page.getByRole('region', { name: 'Changes since checkpoint' });
      await delta.getByText('+guard retries', { exact: true }).waitFor();
      const queue = page.getByRole('navigation', { name: 'Re-review queue' });
      const queueWidth = await queue.evaluate((el) => el.clientWidth);
      await page
        .getByRole('separator', { name: 'Resize re-review queue and diff' })
        .press('ArrowRight');
      assert.ok((await queue.evaluate((el) => el.clientWidth)) > queueWidth);

      await page.getByText('1 outdated draft', { exact: true }).waitFor();
      await page
        .getByRole('navigation', { name: 'Re-review queue' })
        .getByRole('button', { name: /src\/reader.ts.*Needs another look/ })
        .waitFor();
      const removed = await delta.locator('.deletion').first().boundingBox();
      const added = await delta.locator('.addition').first().boundingBox();
      assert.ok(removed && added && removed.y < added.y && removed.x === added.x);
      await capture(page, 'second-push');
      await delta
        .getByRole('button', { name: 'Could concurrent retries bypass this guard?' })
        .click();
      const pin = page.getByRole('dialog', { name: 'Pinned question', exact: true });
      await pin.getByText('Open · Hunk changed', { exact: true }).waitFor();
      await pin.locator('pre').first().filter({ hasText: '+new line 1' }).waitFor();
      await pin.locator('pre').last().filter({ hasText: '+guard retries' }).waitFor();
      await capture(page, 'pinned-question');
      await pin.getByRole('button', { name: 'Mark addressed' }).click();
      await pin.getByText('Addressed · Hunk changed', { exact: true }).waitFor();
      await pin.getByRole('button', { name: 'Close', exact: true }).click();
      await delta
        .getByRole('button', { name: 'Could concurrent retries bypass this guard?' })
        .waitFor({ state: 'hidden' });

      await writeFile(releaseAnswer, '');
      await page.getByRole('button', { name: 'Full PR', exact: true }).click();
      const late = chat.locator('.exchange').filter({ hasText: 'Answer after the push' });
      await late.getByText(/Evidence needs another look/).waitFor();
      await late.locator('.cite').first().click();
      await late.getByText('Original hunk', { exact: true }).click();
      await late
        .locator('blockquote details pre')
        .filter({ hasText: /new line 1/ })
        .waitFor();
      await page.getByRole('button', { name: /Review drafts 1/ }).click();
      assert.equal(
        await page.getByRole('button', { name: 'Preview submission' }).isDisabled(),
        true,
      );
      await page.getByRole('button', { name: 'Move to summary' }).click();
      await page.getByRole('button', { name: 'Save and close' }).click();
      await writeFile(
        revisionFixture,
        JSON.stringify({ ...second, head: 'd'.repeat(40), rewrite: true, line: 'rewritten guard' }),
      );
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('button', { name: 'Open update' }).click();
      await page.getByText('Rewritten history', { exact: true }).waitFor();
      await delta.getByText('+rewritten guard', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Save review checkpoint' }).click();
      await page
        .getByRole('button', { name: 'Save review checkpoint' })
        .waitFor({ state: 'hidden' });
      await writeFile(
        revisionFixture,
        JSON.stringify({
          ...second,
          head: 'd'.repeat(40),
          base: 'e'.repeat(40),
          line: 'retargeted guard',
        }),
      );
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('button', { name: 'Open update' }).click();
      await page.getByText('Base changed', { exact: true }).waitFor();
      await delta.getByText('+retargeted guard', { exact: true }).waitFor();
      const date = new Date().toISOString();
      await writeFile(
        repliesFile,
        JSON.stringify([
          {
            id: 901,
            in_reply_to_id: 75,
            user: { login: 'octo' },
            path: 'src/reader.ts',
            body: 'Added coverage for concurrent retries.',
            created_at: date,
            updated_at: date,
          },
        ]),
      );
      await page.clock.install();
      await page.clock.fastForward(125000);
      // Account for timers created before the test clock was installed.
      await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('focus')));
      await page.getByRole('button', { name: '1 new review reply', exact: true }).click();
      const inbox = page.getByRole('dialog', { name: 'Review replies' });
      await inbox.getByText('Added coverage for concurrent retries.', { exact: true }).waitFor();
      await capture(page, 'reply-inbox');
      await inbox.getByRole('button', { name: 'Mark all read' }).click();
      await inbox.getByText('@fixture-reviewer · 0 unread', { exact: true }).waitFor();
      await inbox.getByRole('button', { name: 'Close' }).click();
      await writeFile(repliesFile, '[]');
      await writeFile(switchedAccount, '');
      await page.getByRole('button', { name: /^Review replies,/ }).click();
      await inbox.getByText('Checking for replies…').waitFor();
      assert.equal(await inbox.getByText('Added coverage for concurrent retries.').count(), 0);
      await inbox.getByText('@second-reviewer · 0 unread', { exact: true }).waitFor();
      assert.equal(await inbox.getByText('Added coverage for concurrent retries.').count(), 0);
      await inbox.getByRole('button', { name: 'Close' }).click();
    }
    await page.getByRole('button', { name: /Workspace/ }).click();
    await page.getByLabel('GitHub pull request URL').waitFor();
    if (!live) {
      // Opening the new pull request clears its highlight and the count on the app icon.
      const freshRow = page.locator('.monitored-pr[data-new]');
      await freshRow.getByRole('button', { name: /Fresh PR/ }).click();
      await freshRow.waitFor({ state: 'detached' });
      if (process.platform !== 'win32')
        assert.equal(await reopened.evaluate(({ app }) => app.getBadgeCount()), 0);
      assert.equal((await reopened.evaluate(() => globalThis.shownAlerts)).length, 1);
    }
    console.info(
      live
        ? 'Live GitHub desktop read and resume passed.'
        : 'Desktop window controls, reader, chat, offline drafts, grouped review, receipt recovery, pushes, rewritten history, base changes and late citations passed.',
    );
  } finally {
    await reopened.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
