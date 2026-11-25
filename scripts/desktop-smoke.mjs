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
const pairFixtures = join(directory, 'comparison-pulls.json');
const pairPush = join(directory, 'comparison-push');
const slowList = join(directory, 'slow-comparison-list');
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
  await writeFile(join(repository, 'callers.txt'), longLines.join('\n') + '\n');
  git('add', '.');
  git('commit', '-qm', 'before');
  review.meta.draft = true;
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
  // Three real branch heads share a merge base. Their files merge cleanly.
  await writeFile(join(repository, 'emit.ts'), 'send({ accountId: account.id });\n');
  git('add', 'emit.ts');
  git('commit', '-qm', 'event contract');
  const pairBase = git('rev-parse', 'HEAD');
  const pairPulls = [];
  for (const [number, title, path, body] of [
    [21, 'Rename event field in @emit.ts', 'emit.ts', 'send({ customerId: account.id });'],
    [22, 'Consume emitted event', 'consume.ts', 'record(event.accountId);'],
    [23, 'Adjust margin', 'layout.css', 'main { margin: 1em; }'],
  ]) {
    git('switch', '--quiet', '-c', 'pair-' + number, pairBase);
    await writeFile(join(repository, path), body + '\n');
    git('add', path);
    git('commit', '-qm', title);
    const head = git('rev-parse', 'HEAD');
    const patch = git('diff', '--no-color', pairBase, head, '--', path).split('\n').slice(4);
    const header = patch.findIndex((line) => line.startsWith('@@ '));
    pairPulls.push({
      number,
      title,
      base: { ref: 'main', sha: pairBase },
      head: { ref: 'pair-' + number, sha: head },
      file: {
        filename: path,
        status: number === 21 ? 'modified' : 'added',
        sha: git('rev-parse', 'HEAD:' + path),
        additions: 1,
        deletions: Number(number === 21),
        patch: patch.slice(header).join('\n'),
      },
    });
  }
  await writeFile(pairFixtures, JSON.stringify(pairPulls));
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
      'const pairPulls = JSON.parse(fs.readFileSync(' + JSON.stringify(pairFixtures) + '));',
      "const endpoint = process.argv.find(a=>a.startsWith('repos/')) ?? '';",
      "if(endpoint==='repos/example/project/pulls/14' && fs.existsSync(" +
        JSON.stringify(join(directory, 'merged-14')) +
        ")) {response.meta.state='closed'; response.meta.merged_at='2026-11-24T12:00:00Z';}",
      'const slowList = ' + JSON.stringify(slowList) + ';',
      "if(endpoint.includes('/pulls?state=open') && fs.existsSync(slowList)){fs.writeFileSync(slowList+'.pid',String(process.pid));setTimeout(()=>console.log('[]'),29000);return;}",
      "if(endpoint.includes('/pulls?state=open')) { console.log(JSON.stringify(pairPulls)); return; }",
      "const pair = pairPulls.find(p => endpoint.split('/')[4] === String(p.number));",
      "if(pair && endpoint.includes('/pulls/')) { if(pair.number===22 && fs.existsSync(" +
        JSON.stringify(pairPush) +
        ")) pair.head.sha='d'.repeat(40);console.log(JSON.stringify(endpoint.includes('/files?') ? [pair.file] : {...response.meta,...pair,state:'open',changed_files:1}));return; }",
      'const changedReview = fs.existsSync(' +
        JSON.stringify(repliesFile) +
        ") && process.argv.some(a=>a.includes('pullRequest(number:12)'));",
      "if(process.argv.includes('graphql') && process.argv.some(a=>a.includes('query ReviewStatus'))){console.log(JSON.stringify({data:{repository:{pullRequest:{state:'OPEN',headRefOid:changedReview?'f'.repeat(40):response.meta.head.sha,isDraft:!!response.meta.draft,commits:{totalCount:3},reviewDecision:'REVIEW_REQUIRED',latestOpinionatedReviews:{nodes:[{author:{login:'teammate'},state:'APPROVED'}],pageInfo:{hasNextPage:false,endCursor:null}},latest:{nodes:changedReview?[{commit:{oid:response.meta.head.sha}}]:[]},dismissed:{totalCount:changedReview?1:0}}}}}));return;}",
      // The reviewer counts as having approved once the grouped review has been posted.
      "if(process.argv.includes('graphql') && process.argv.some(a=>a.includes('latestOpinionatedReviews'))){const query=process.argv.find(a=>a.startsWith('query='));const state=fs.existsSync(" +
        JSON.stringify(posted) +
        ")?[{author:{login:'fixture-reviewer'},state:'APPROVED'}]:[];console.log(JSON.stringify({data:{viewer:{login:'fixture-reviewer'},repository:Object.fromEntries([...query.matchAll(/(p\\d+):pullRequest/g)].map(m=>[m[1],{isDraft:m[1]==='p12',headRefOid:response.meta.head.sha,commits:{totalCount:3},reviewDecision:state.length?'APPROVED':'REVIEW_REQUIRED',latestOpinionatedReviews:{pageInfo:{hasNextPage:false,endCursor:null},nodes:m[1]==='p12'?[{author:{login:'teammate'},state:'APPROVED'},...state]:[]}}]))}}));return;}",
      'const {actionsFixture} = require(' +
        JSON.stringify(resolve('fixtures/github/actions.mjs')) +
        ');',
      'const pipelineStage = fs.existsSync(' +
        JSON.stringify(join(directory, 'pipeline-done')) +
        ') ? "passed" : fs.existsSync(' +
        JSON.stringify(join(directory, 'pipeline-failed')) +
        ') ? "failed" : "running";',
      'const ci = actionsFixture(endpoint,response.meta.head.sha,pipelineStage,!!update);',
      "if(ci !== undefined) { if(process.argv.includes('--method') || process.argv.includes('-X')) throw Error('Unexpected CI write'); console.log(JSON.stringify(ci)); return; }",
      // Review threads and whether each is resolved.
      'const resolvedFile = ' + JSON.stringify(join(directory, 'resolved')) + ';',
      "if(process.argv.includes('graphql') && process.argv.some(a=>a.includes('ReviewThread('))){const on=process.argv.some(a=>a.includes('mutation($thread:ID!){resolveReviewThread'));if(on)fs.writeFileSync(resolvedFile,'');else if(fs.existsSync(resolvedFile))fs.unlinkSync(resolvedFile);console.log(JSON.stringify({data:{[on?'resolveReviewThread':'unresolveReviewThread']:{thread:{isResolved:on}}}}));return;}",
      "if(process.argv.includes('graphql') && process.argv.some(a=>a.includes('reviewThreads('))){const done=fs.existsSync(resolvedFile);console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{id:'PRRT_fixture56',isResolved:done,viewerCanResolve:!done,viewerCanUnresolve:done,comments:{nodes:[{databaseId:56}]}}]}}}}}));return;}",
      'const repliesFile = ' + JSON.stringify(repliesFile) + ';',
      'const loginRelease = ' + JSON.stringify(loginRelease) + ';',
      'const signedOut = ' + JSON.stringify(signedOut) + ';',
      'const switchedAccount = ' + JSON.stringify(switchedAccount) + ';',
      // One open pull request asks the signed-in account for a review.
      "if(process.argv.includes('graphql') && process.argv.some(a=>a.includes('query ReviewRequests'))){console.log(JSON.stringify({data:{viewer:{login:fs.existsSync(switchedAccount)?'second-reviewer':'fixture-reviewer'},search:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{__typename:'PullRequest',number:31,title:'Requested PR',isDraft:false,updatedAt:'2026-11-24T12:00:00Z',headRefOid:'e'.repeat(40),author:{login:'octo'},repository:{nameWithOwner:'example/requests'},reviewRequests:{nodes:[{requestedReviewer:{__typename:'Team'}}]}}]}}}));return;}",
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
      "else if(process.argv.some(a=>a.includes('/contributors?'))) console.log(JSON.stringify([{login:'octo'},{login:'other'},...Array.from({length:28},(_,i)=>({login:'contributor-'+(i+1)}))]));",
      // A second pull request is opened once the test asks for it.
      "else if(process.argv.some(a=>a.includes('/issues?'))) console.log(JSON.stringify([{number:12,title:'Tracked PR',user:{login:'octo'},created_at:response.meta.created_at,pull_request:{}},...(fs.existsSync(" +
        JSON.stringify(join(directory, 'new-pr')) +
        ")?[{number:14,title:'Fresh PR',user:{login:'octo'},pull_request:{}}]:[])]));",
      "else if(process.argv.some(a=>a.includes('/pulls?'))) console.log(JSON.stringify([{number:12,title:'Tracked PR',user:{login:'octo'}},{number:13,title:'Other PR',user:{login:'other'}}]));",
      "else if(process.argv.some(a=>a.includes('/compare/'))) { const from=process.argv.find(a=>a.includes('/compare/')).split('/compare/')[1].split('...')[0]; console.log(JSON.stringify({status:update?.rewrite?'diverged':'ahead',merge_base_commit:{sha:from},files:update?[{...response.files[1],additions:1,deletions:1,patch:'@@ -40 +40 @@\\n-new line 1\\n+'+update.line}]:[]})); }",
      "else if(process.argv.includes('Accept: application/vnd.github.diff')) process.stdout.write(response.raw);",
      "else process.stdout.write(JSON.stringify(process.argv.some(a=>a.includes('/files?')) ? response.files : response.meta));",
    ].join('\n'),
    { mode: 0o755 },
  );
  for (const id of ['codex', 'claude', 'agent', 'agy', 'copilot']) {
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
// The harness and model are chosen once, in the Review chat header, for the whole app.
async function chooseHarness(page, { agent, model }) {
  await page.getByRole('button', { name: /^Harness and model: / }).click();
  const form = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  if (agent) await form.getByLabel('Harness', { exact: true }).selectOption(agent);
  if (agent === 'cursor' || agent === 'antigravity') {
    await form.locator('datalist option[value="fixture-model"]').waitFor({ state: 'attached' });
  }
  await form.getByLabel('Model', { exact: true }).fill(model);
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: new RegExp('^Harness and model: .* · ' + model + '$') })
    .waitFor();
}
async function checkMacFrame(app, theme) {
  if (process.platform === 'darwin') {
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), theme);
  }
}
async function chooseLayout(page, order) {
  const trigger = page.getByRole('button', { name: 'Review layout', exact: true });
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Review layout' });
  if (preview && order === 'Chat → Diff → Files') await capture(page, 'layout-picker');
  await dialog.getByRole('button', { name: order, exact: true }).press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  await trigger.and(page.locator(':focus')).waitFor();
}
const paneOrder = (page) =>
  page
    .locator('.workbench > [data-panel]:visible')
    .evaluateAll((panels) => panels.map((el) => el.id));
const changedFiles = (page) => page.getByRole('navigation', { name: 'Changed files' });
const ask = (page) => page.getByRole('button', { name: 'Ask about PR', exact: true }).click();
const back = (page) => page.getByRole('button', { name: 'Pull requests', exact: true }).click();
try {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await resize(app, page, 1380, 720);
    await page.getByRole('heading', { name: 'Add your first repository' }).waitFor();
    await capture(page, 'workspace');
    if (!live) {
      // Pull requests waiting for this account's review are listed without monitoring a
      // repository. A request already waiting at the first check is not marked as new.
      const requestsLink = page.getByRole('button', {
        name: 'Review requests, 1 open',
        exact: true,
      });
      await requestsLink.press('Enter');
      await page.getByRole('heading', { name: 'Review requests', exact: true }).waitFor();
      await requestsLink.and(page.locator('[aria-current=page]')).waitFor();
      const requested = page
        .getByRole('region', { name: 'Review requests' })
        .locator('.monitored-pr');
      await requested
        .getByRole('button', { name: /Requested PR.*example\/requests.*@octo.*Team request/ })
        .waitFor();
      await requested
        .getByRole('button', { name: 'Summarise pull request example/requests #31', exact: true })
        .waitFor();
      assert.equal(await requested.getByText('New', { exact: true }).count(), 0);
      await page.getByText(/^Requested from @fixture-reviewer · Checked /).waitFor();
      await capture(page, 'review-requests');
      await writeFile(signedOut, '');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settingsPane = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settingsPane.getByRole('button', { name: 'Connect account' }).press('Enter');
      await settingsPane.getByText('ABCD-1234', { exact: true }).waitFor();
      await writeFile(loginRelease, '');
      await settingsPane.getByText('@fixture-reviewer', { exact: true }).waitFor();
      await settingsPane.getByLabel('Interface font').selectOption('humanist');
      await settingsPane.getByLabel('Base font size').selectOption('18');
      await settingsPane.getByLabel('Code font').selectOption({ label: 'Fira Code' });
      await settingsPane.getByText('Midnight', { exact: true }).click();
      await page.waitForFunction(
        () =>
          globalThis.document.documentElement.dataset.palette === 'midnight' &&
          globalThis.document.documentElement.dataset.font === 'humanist' &&
          globalThis.getComputedStyle(globalThis.document.documentElement).fontSize === '18px',
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
      await checkMacFrame(app, 'dark');
      await capture(page, 'accent');
      await settingsPane.getByText('Light', { exact: true }).click();
      await page.waitForFunction(
        () =>
          globalThis.getComputedStyle(globalThis.document.documentElement).colorScheme === 'light',
      );
      const vibrancy = settingsPane.getByRole('checkbox', { name: 'Sidebar vibrancy' });
      if (process.platform === 'darwin') {
        assert.equal(await vibrancy.isChecked(), false);
        await vibrancy.check();
        await page.locator('html.sidebar-vibrancy').waitFor();
        const surfaces = await page.evaluate(() => {
          const style = (selector) =>
            globalThis.getComputedStyle(globalThis.document.querySelector(selector))
              .backgroundColor;
          return {
            reduce: globalThis.matchMedia('(prefers-reduced-transparency: reduce)').matches,
            root: style('html'),
            sidebar: style('.repo-sidebar'),
            page: style('.studio-page'),
          };
        });
        if (!surfaces.reduce) {
          assert.equal(surfaces.root, 'rgba(0, 0, 0, 0)');
          assert.match(surfaces.sidebar, /(?:rgba|\/)/);
          assert.match(surfaces.page, /^rgb\(|^color\([^/]+\)$/);
        }
        await vibrancy.uncheck();
        await page.locator('html:not(.sidebar-vibrancy)').waitFor();
        await vibrancy.check();
        await page.locator('html.sidebar-vibrancy').waitFor();
      } else {
        assert.equal(await vibrancy.count(), 0);
      }
      // Single-key shortcuts are on by default and the choice is saved.
      const shortcutSetting = settingsPane.getByRole('checkbox', { name: 'Single-key shortcuts' });
      assert.equal(await shortcutSetting.isChecked(), true);
      await shortcutSetting.uncheck();
      await page.waitForFunction(async () => !(await globalThis.reviewer.getSingleKeyShortcuts()));
      await shortcutSetting.check();
      await page.waitForFunction(() => globalThis.reviewer.getSingleKeyShortcuts());
      await checkMacFrame(app, 'light');
      await capture(page, 'light-settings');
      await settingsPane.getByText('Green', { exact: true }).click();
      await settingsPane.getByLabel('Base font size').selectOption('16');
      await settingsPane.getByRole('button', { name: 'Close' }).click();
      assert.equal(await page.getByRole('button', { name: /^Appearance/ }).count(), 0);
    }
    const toolsRail = page.getByRole('navigation', { name: 'Workspace tools' });
    const repositories = page.getByRole('navigation', { name: 'Repositories', exact: true });
    await repositories.getByRole('heading', { name: 'Repositories' }).waitFor();
    const bell = toolsRail.getByRole('button', { name: /^Review alerts,/ });
    const gear = toolsRail.getByRole('button', { name: 'Settings', exact: true });
    assert.equal(await toolsRail.getByRole('button').count(), 3);
    const [bellBox, gearBox, repoBox] = await Promise.all([
      bell.boundingBox(),
      gear.boundingBox(),
      repositories.boundingBox(),
    ]);
    assert.ok(bellBox && gearBox && repoBox);
    assert.equal((await toolsRail.boundingBox()).width, 52);
    assert.equal(bellBox.x, gearBox.x);
    assert.ok(bellBox.y + bellBox.height <= gearBox.y);
    assert.ok(gearBox.x + gearBox.width <= repoBox.x);
    const bottomGap =
      (await page.evaluate(() => globalThis.innerHeight)) - gearBox.y - gearBox.height;
    assert.ok(bottomGap >= 0 && bottomGap <= 16);
    await bell.press('Enter');
    const alertPane = page.getByRole('region', { name: 'Review alerts' });
    await alertPane
      .getByRole('button', { name: 'Close review alerts' })
      .and(page.locator(':focus'))
      .waitFor();
    assert.equal(await repositories.isVisible(), false);
    await alertPane.getByRole('button', { name: 'Close review alerts' }).press('Enter');
    await bell.and(page.locator(':focus')).waitFor();
    await repositories.waitFor();
    assert.equal(await page.getByRole('region', { name: 'Review chat' }).count(), 0);
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
        globalThis.localStorage.setItem('react-resizable-panels:review-with-chat', 'invalid'),
      );
    assert.equal(await page.getByRole('button', { name: /^Harness and model/ }).count(), 0);
    await page.getByRole('button', { name: 'Open review', exact: true }).click();
    await page.getByLabel('GitHub pull request URL').fill(url);
    await page.getByRole('button', { name: 'Save pull request' }).click();
    if (!live)
      await repositories
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: 'Pull request #12', exact: true }) })
        .locator('.sidebar-review-meta')
        .filter({ hasText: /^#12 · Saved / })
        .waitFor();
    await page
      .locator('.pr-queue')
      .getByRole('button', { name: live ? /octocat\/hello-world/ : /example\/project/ })
      .click();
    const region = page.getByRole('region', { name: 'File diff' });
    await region.waitFor({ timeout: 45000 });
    assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
    if (!live) {
      await repositories
        .getByRole('listitem')
        .filter({ has: page.locator('[aria-current="page"]') })
        .locator('.sidebar-review-meta')
        .filter({ hasText: /^#12 · @reviewer/ })
        .waitFor();
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      const description = page.getByRole('region', { name: 'PR description' });
      await description.getByRole('heading', { level: 2, name: 'What changes' }).waitFor();
      assert.equal(
        await description.getByRole('listitem').locator('strong').innerText(),
        'Review progress:',
      );
      await page.getByRole('button', { name: 'Changes', exact: true }).click();
      const initialChat = page.getByRole('region', { name: 'Review chat' });
      await initialChat.waitFor();
      const [diffHeader, chatHeader] = await Promise.all([
        page.locator('.review-center > header').boundingBox(),
        initialChat.locator('.chat-heading').boundingBox(),
      ]);
      assert.equal(diffHeader.y, 0);
      assert.equal(chatHeader.y, diffHeader.y);
      assert.ok(chatHeader.x >= diffHeader.x + diffHeader.width);
      await resize(app, page, 570, 440);
      const compactChat = await initialChat.boundingBox();
      const compactDiff = await page.locator('#review-diff').boundingBox();
      assert.ok(compactChat && compactDiff && compactChat.height > 0 && compactDiff.height > 0);
      assert.ok(compactChat.y >= compactDiff.y + compactDiff.height - 1);
      await capture(page, 'compact-pr');
      await resize(app, page, 1380, 720);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Settings' })
        .getByRole('button', { name: 'Close' })
        .click();
      await back(page);
      await resize(app, page, 570, 720);
      assert.ok(
        await page.locator('.shell').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
      await resize(app, page, 1380, 720);
      await page.getByRole('button', { name: 'Add repository', exact: true }).click();
      await page.getByLabel('Repository', { exact: true }).fill('example/project');
      await capture(page, 'add-repository');
      await page
        .getByRole('dialog', { name: 'Add repository' })
        .getByRole('button', { name: 'Add repository' })
        .click();
      const dialog = page.getByRole('dialog', { name: 'example/project' });
      await dialog.getByRole('button', { name: 'Select authors' }).press('Enter');
      const picker = page.getByRole('dialog', { name: 'Select authors' });
      const search = picker.getByRole('searchbox', { name: 'Search authors' });
      await search.and(page.locator(':focus')).waitFor();
      assert.ok((await picker.getByRole('checkbox').count()) >= 30);
      assert.ok(
        await picker.getByRole('group').evaluate((el) => el.scrollHeight > el.clientHeight),
      );
      await search.fill('@CONTRIBUTOR-28');
      await picker.getByLabel('contributor-28', { exact: true }).check();
      await search.fill('octo');
      await picker.getByLabel('octo', { exact: true }).check();
      await search.fill('extra-login');
      await picker.getByRole('button', { name: 'Monitor @extra-login' }).click();
      await picker.getByText('3 selected', { exact: true }).waitFor();
      await search.fill('');
      await capture(page, 'author-picker');
      await picker.getByRole('button', { name: 'Apply selection' }).click();
      await dialog.getByRole('button', { name: 'Select authors, 3 selected' }).click();
      assert.ok(await picker.getByLabel('extra-login', { exact: true }).isChecked());
      assert.ok(await picker.getByLabel('octo', { exact: true }).isChecked());
      await picker.getByLabel('contributor-28', { exact: true }).uncheck();
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: 'Select authors, 3 selected' }).click();
      assert.ok(await picker.getByLabel('contributor-28', { exact: true }).isChecked());
      await picker.getByLabel('contributor-28', { exact: true }).uncheck();
      await picker.getByLabel('extra-login', { exact: true }).uncheck();
      await picker.getByRole('button', { name: 'Apply selection' }).click();
      await dialog.getByRole('button', { name: 'Select authors, 1 selected' }).waitFor();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      const sidebar = page.getByRole('complementary', { name: 'Repository sidebar' });
      await page
        .locator('.pr-queue')
        .getByRole('button', { name: /Tracked PR.*Draft/ })
        .click();
      await ask(page);
      async function compare() {
        await sidebar.getByRole('button', { name: 'Manage authors for example/project' }).click();
        await page
          .getByRole('dialog', { name: 'example/project' })
          .getByRole('button', { name: 'Compare pull requests' })
          .click();
      }
      const pairDialog = page.getByRole('dialog', { name: 'Compare pull requests' });
      for (const agent of ['cursor', 'antigravity', 'copilot']) {
        await chooseHarness(page, { agent, model: 'fixture-model' });
        await compare();
        await pairDialog.getByLabel('First pull request').selectOption('21');
        await pairDialog.getByLabel('Second pull request').selectOption('22');
        await pairDialog.getByRole('button', { name: 'Compare revisions' }).click();
        await pairDialog.getByRole('button', { name: 'Investigate with selected agent' }).click();
        await pairDialog
          .getByText('The consumer reads a field the producer no longer emits.')
          .waitFor();
        const shownModel = agent === 'antigravity' ? 'reported-fixture-model' : 'fixture-model';
        await pairDialog.getByText(agent + ' · ' + shownModel, { exact: true }).waitFor();
        await pairDialog.getByRole('button', { name: 'Close', exact: true }).click();
      }
      await chooseHarness(page, { agent: 'codex', model: 'fixture-model' });
      await writeFile(slowList, '');
      await compare();
      // Close while gh is actually waiting on a page of results.
      let scanPid;
      for (let wait = 0; wait < 100 && !scanPid; wait++) {
        scanPid = Number(await readFile(slowList + '.pid', 'utf8').catch(() => ''));
        if (!scanPid) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(scanPid, 'GitHub candidate scan started');
      await pairDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await rm(slowList);
      await compare();
      await pairDialog.getByLabel('First pull request').selectOption('21');
      await pairDialog.getByLabel('Second pull request').selectOption('22');
      assert.throws(() => process.kill(scanPid, 0), { code: 'ESRCH' });
      await pairDialog.getByRole('button', { name: 'Compare revisions' }).click();
      await pairDialog.getByText('No shared paths in the available diffs.').waitFor();
      await pairDialog.getByRole('button', { name: 'Investigate with selected agent' }).click();
      await pairDialog
        .getByText('The consumer reads a field the producer no longer emits.')
        .waitFor();
      await pairDialog.getByText('send({ customerId: account.id });', { exact: true }).waitFor();
      await pairDialog.getByText('record(event.accountId);', { exact: true }).waitFor();
      const pairCommits = JSON.parse(await readFile(pairFixtures, 'utf8'));
      await app.evaluate(({ shell }) => {
        globalThis.originalPairLink = shell.openExternal;
        globalThis.pairLinks = [];
        shell.openExternal = async (url) => {
          globalThis.pairLinks.push(url);
        };
      });
      await pairDialog.getByRole('button', { name: 'emit.ts:1', exact: true }).click();
      await pairDialog.getByRole('button', { name: 'consume.ts:1', exact: true }).click();
      assert.deepEqual(
        await app.evaluate(({ shell }) => {
          shell.openExternal = globalThis.originalPairLink;
          return globalThis.pairLinks;
        }),
        pairCommits
          .slice(0, 2)
          .map(
            (p) =>
              'https://github.com/example/project/blob/' +
              p.head.sha +
              '/' +
              p.file.filename +
              '#L1',
          ),
      );
      await writeFile(pairPush, '');
      await pairDialog.getByRole('button', { name: 'Check for updates' }).click();
      await pairDialog.getByText(/Comparison is stale.*#22/).waitFor();
      await pairDialog.getByLabel('Second pull request').selectOption('23');
      await pairDialog.getByRole('button', { name: 'Compare revisions' }).click();
      await pairDialog.getByRole('button', { name: 'Investigate with selected agent' }).click();
      await pairDialog.getByText('No interaction identified in the inspected evidence.').waitFor();
      await pairDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await back(page);
      if (preview) await resize(app, page, 1506, 720);
      await page.getByRole('heading', { name: 'Pull requests', exact: true }).waitFor();
      await capture(page, 'repository-queue');
      assert.equal(await page.getByRole('region', { name: 'Review chat' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /Other PR/ }).count(), 0);
      const folderList = sidebar.getByRole('list', { name: 'Reviews in example/project' });
      const sidebarPr = folderList.getByRole('button', { name: '#12 Tracked PR', exact: true });
      assert.equal(await sidebarPr.count(), 1);
      await sidebar.getByRole('button', { name: 'Collapse example/project' }).press('Enter');
      await folderList.waitFor({ state: 'hidden' });
      await sidebar.getByRole('button', { name: 'Expand example/project' }).press('Enter');
      const { meta } = JSON.parse(await readFile(join(directory, 'review.json'), 'utf8'));
      const opened = await page.evaluate(
        (date) =>
          'Opened ' +
          new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(date)),
        meta.created_at,
      );
      const prRow = folderList
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: '#12 Tracked PR', exact: true }) });
      assert.equal(
        (await prRow.locator('.sidebar-review-meta').innerText()).replace(/\s+/g, ' '),
        '#12 · @octo · Draft · ' + opened,
      );
      await prRow.locator('.sidebar-review-meta').getByText('Draft', { exact: true }).waitFor();
      await prRow.getByText('3 commits', { exact: false }).waitFor();
      const commit = 'https://github.com/example/project/commit/' + meta.head.sha;
      const sidebarLink = prRow.getByRole('link', { name: meta.head.sha.slice(0, 8) });
      async function hasAccentText(link) {
        return link.locator('code').evaluate((code) => {
          const color = globalThis.getComputedStyle(code).color;
          code.style.color = 'var(--accent)';
          const accent = globalThis.getComputedStyle(code).color;
          code.style.removeProperty('color');
          return color === accent;
        });
      }
      assert.ok(await hasAccentText(sidebarLink));
      assert.equal(await sidebarLink.getAttribute('href'), commit);
      await app.evaluate(({ shell }) => {
        globalThis.originalCommitLink = shell.openExternal;
        globalThis.commitLinks = [];
        shell.openExternal = async (url) => {
          globalThis.commitLinks.push(url);
        };
      });
      const prNumber = { name: '#12', exact: true };
      for (const link of [
        prRow.getByRole('link', prNumber),
        page.getByRole('main').getByRole('link', prNumber),
      ]) {
        assert.ok(await hasAccentText(link));
        assert.equal(await link.getAttribute('href'), url);
        await link.click();
      }
      await sidebarLink.click();
      await page.getByRole('heading', { name: 'Pull requests', exact: true }).waitFor();
      await sidebarPr
        .getByTitle('Partially approved · further review required', { exact: true })
        .waitFor();
      assert.equal(
        await sidebar.evaluate((el) => globalThis.getComputedStyle(el).borderRightWidth),
        '0px',
      );
      await sidebarPr.click();
      await sidebarPr.and(page.locator('[aria-current="page"]')).waitFor();
      await changedFiles(page).waitFor();
      await page.locator('.pr-meta').getByText('Draft', { exact: true }).waitFor();
      await page.locator('.pr-meta').getByText(opened, { exact: true }).waitFor();
      const headerLink = page
        .locator('.pr-meta')
        .getByRole('link', { name: meta.head.sha.slice(0, 8) });
      assert.ok(await hasAccentText(headerLink));
      const headerNumber = page.locator('.review-center > header').getByRole('link', prNumber);
      assert.ok(await hasAccentText(headerNumber));
      await headerNumber.press('Enter');
      await headerLink.press('Enter');
      assert.deepEqual(
        await app.evaluate(({ shell }) => {
          shell.openExternal = globalThis.originalCommitLink;
          return globalThis.commitLinks;
        }),
        [url, url, commit, url, commit],
      );
      assert.equal(await page.getByRole('button', { name: 'PR discussions' }).count(), 0);
      await page.keyboard.press('Control+f');
      const diffSearch = page.getByRole('search', { name: 'Search PR diff' });
      const query = diffSearch.getByRole('searchbox', { name: 'Search changed lines' });
      const scope = diffSearch.getByLabel('Lines to search');
      const match = region.locator('.code-line mark');
      await query.fill('RE');
      await diffSearch.getByText('1 of 4', { exact: true }).waitFor();
      await match.filter({ hasText: /^Re$/ }).waitFor();
      await region.focus();
      await page.keyboard.press('F3');
      await page.getByRole('heading', { name: 'obsolete.txt', exact: true }).waitFor();
      assert.equal(await match.innerText(), 're');
      await page.keyboard.press('F3');
      await diffSearch.getByText('3 of 4', { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const mark = globalThis.document.querySelector('.code-line mark');
        if (!mark) return false;
        const before = globalThis.document.createRange();
        before.selectNodeContents(mark.parentElement);
        before.setEndBefore(mark);
        return before.toString() === '-reti';
      });
      await page.keyboard.press('Shift+F3');
      await query.press('Shift+Enter');
      await page.getByRole('heading', { name: 'README.md', exact: true }).waitFor();
      await scope.selectOption('removed');
      await diffSearch.getByText('1 of 3', { exact: true }).waitFor();
      await query.press('Shift+Enter');
      await region.locator('[data-old-line="850"] mark').waitFor();
      await scope.selectOption('added');
      await diffSearch.getByText('1 of 1', { exact: true }).waitFor();
      await query.fill('new line 60');
      await region.locator('[data-new-line="99"] mark').waitFor();
      await query.fill('unmatched-text-in-this-pr');
      await diffSearch.getByText('No matches', { exact: true }).waitFor();
      assert.equal(await match.count(), 0);
      await query.fill('first change');
      await region.locator('[data-new-line="1"] mark').waitFor();
      await query.press('Enter');
      await diffSearch.getByText('1 of 1', { exact: true }).waitFor();
      await query.press('Escape');
      await page
        .getByRole('button', { name: 'Search diff', exact: true })
        .and(page.locator(':focus'))
        .waitFor();
      assert.equal(await match.count(), 0);
      await page.getByRole('button', { name: /^src\/reader\.ts, modified/ }).click();
      if (preview) {
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .and(page.locator(':enabled'))
          .waitFor();
        await capture(page, 'repository-review');
        await resize(app, page, 1380, 720);
      }
      const discussions = page.locator('.pr-conversation');
      await page.getByRole('button', { name: 'Discussion', exact: true }).click();
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
      await discussionThread.getByRole('button', { name: 'Remember review lesson' }).click();
      const lessonEditor = page.getByRole('dialog', { name: 'Remember review lesson' });
      await lessonEditor
        .getByLabel('Private reminder')
        .fill('Check the callers before changing this behaviour.');
      await lessonEditor.getByRole('button', { name: 'Save lesson' }).click();
      await discussionThread.getByRole('button', { name: 'Edit review lesson' }).click();
      assert.equal(
        await page.getByRole('region', { name: 'Review lessons for this file' }).count(),
        0,
      );
      const editLesson = page.getByRole('dialog', { name: 'Edit review lesson' });
      await editLesson.getByLabel('Code fragment').fill('first change');
      await editLesson.getByRole('button', { name: 'Save lesson' }).click();
      await editLesson.waitFor({ state: 'detached' });
      assert.equal(
        await page.getByRole('region', { name: 'Review lessons for these changes' }).count(),
        0,
      );
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
      const readerBeforeFailure = await page.evaluate(
        async (url) => globalThis.reviewer.cachedReview(url),
        url,
      );
      await writeFile(join(directory, 'pipeline-failed'), '');
      await pipelineView.getByRole('button', { name: 'Refresh' }).click();
      const failedJob = (name) =>
        pipelineView
          .locator('.pipeline-job')
          .filter({ has: page.locator('summary').getByText(name, { exact: true }) })
          .getByRole('button', { name: 'Investigate failure' });
      await failedJob('check').click();
      const diagnostic = (message) =>
        pipelineView.getByRole('listitem').filter({ hasText: message });
      await diagnostic('Expected retries to stop.')
        .getByRole('button', { name: 'Inspect code' })
        .click();
      await pipelineView.getByText('Changed hunk 2 · src/reader.ts:40').waitFor();
      await pipelineView
        .locator('[data-annotated=true]')
        .getByText('+new line 1', { exact: true })
        .waitFor();
      // Hold a real source subprocess in flight and verify closing its excerpt releases it.
      const gitShim = join(directory, 'git');
      const sourcePid = join(directory, 'annotated-source.pid');
      await writeFile(
        gitShim,
        [
          '#!/usr/bin/env node',
          'const args = process.argv.slice(2);',
          "if(args.includes(':(literal)callers.txt')) {",
          "require('node:fs').writeFileSync(" +
            JSON.stringify(sourcePid) +
            ', String(process.pid));setTimeout(() => {}, 29000);',
          "} else {const result = require('node:child_process').spawnSync('git', args, {env:{...process.env,PATH:" +
            JSON.stringify(process.env.PATH) +
            "},stdio:'inherit'});process.exit(result.status ?? 1);}",
        ].join('\n'),
        { mode: 0o755 },
      );
      await diagnostic('Caller assertion differs.')
        .getByRole('button', { name: 'Inspect code' })
        .click();
      let pid;
      for (let i = 0; i < 100 && !pid; i++) {
        pid = Number(await readFile(sourcePid, 'utf8').catch(() => ''));
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(pid, 'The annotated source read reached Git');
      await diagnostic('Caller assertion differs.')
        .getByRole('button', { name: 'Close code' })
        .click();
      await rm(gitShim);
      await diagnostic('Caller assertion differs.')
        .getByRole('button', { name: 'Inspect code' })
        .click();
      await pipelineView.getByText('Pinned source · callers.txt:500').waitFor();
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await pipelineView
        .locator('[data-annotated=true]')
        .getByText('fixture row 500', { exact: true })
        .waitFor();
      await pipelineView.getByRole('button', { name: 'Back to pipeline' }).click();
      await failedJob('runner setup').click();
      await pipelineView.getByText('Failed steps · Set up job').waitFor();
      await pipelineView.getByText(/This job reported no check annotations/).waitFor();
      await pipelineView.getByRole('button', { name: 'Open original job on GitHub' }).waitFor();
      await pipelineView.getByRole('button', { name: 'Back to pipeline' }).click();
      await failedJob('checks access').click();
      await pipelineView.getByText(/Check annotations are unavailable/).waitFor();
      await pipelineView.getByRole('button', { name: 'Back to pipeline' }).click();
      await writeFile(join(directory, 'pipeline-done'), '');
      await pipelineView.getByRole('button', { name: 'Refresh' }).click();
      await pipelineRun
        .getByText('Passed · pull_request · run #7 · attempt 2 · 1m 5s', { exact: true })
        .waitFor();
      await pipelineView.getByRole('button', { name: 'Previous attempt' }).click();
      await failedJob('check').click();
      await diagnostic('Expected retries to stop.').waitFor();
      await pipelineView.getByText(/attempt 1 · job #901/).waitFor();
      await pipelineView.getByRole('button', { name: 'Close' }).click();
      const readerAfterFailure = await page.evaluate(
        async (url) => globalThis.reviewer.cachedReview(url),
        url,
      );
      assert.equal(readerAfterFailure.selected, readerBeforeFailure.selected);
      assert.deepEqual(readerAfterFailure.files, readerBeforeFailure.files);
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
      await page.getByRole('button', { name: 'Discussion', exact: true }).click();
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
      await page.getByRole('button', { name: 'Changes', exact: true }).click();
      await page.getByRole('button', { name: 'README.md, added', exact: true }).click();
      const chat = page.getByRole('region', { name: 'Review chat' });
      await ask(page);
      const headerPicker = chat
        .locator('.chat-heading')
        .getByRole('button', { name: /^Harness and model:/ });
      await headerPicker.waitFor();
      await chat.getByRole('heading', { name: 'Review chat' }).hover();
      const pickerColours = () =>
        headerPicker.evaluate((el) => {
          const style = globalThis.getComputedStyle(el);
          return [style.backgroundColor, style.borderTopColor];
        });
      const transparent = 'rgba(0, 0, 0, 0)';
      assert.deepEqual(await pickerColours(), [transparent, transparent]);
      const idleBounds = await headerPicker.boundingBox();
      await headerPicker.hover();
      assert.ok((await pickerColours()).every((colour) => colour !== transparent));
      assert.deepEqual(await headerPicker.boundingBox(), idleBounds);
      const files = changedFiles(page);
      const treeFolder = files.getByRole('button', { name: 'src', exact: true });
      await treeFolder.click();
      await files.getByRole('button', { name: /^src\/reader/ }).waitFor({ state: 'hidden' });
      await files.getByLabel('Filter files').fill('reader');
      await files.getByRole('button', { name: /^src\/reader/ }).waitFor();
      await files.getByLabel('Filter files').fill('');
      await treeFolder.click();
      const filesDivider = page.getByRole('separator', { name: 'Resize files and diff' });
      const filesWidth = await files.evaluate((el) => el.clientWidth);
      await filesDivider.press('ArrowRight');
      assert.ok((await files.evaluate((el) => el.clientWidth)) > filesWidth);
      await filesDivider.press('ArrowLeft');
      await files.getByRole('button', { name: 'Collapse file tree' }).click();
      const showFiles = page.getByRole('button', { name: 'Show changed files' });
      await showFiles.and(page.locator(':focus')).waitFor();
      await files.waitFor({ state: 'hidden' });
      await chooseLayout(page, 'Chat → Diff → Files');
      await files.waitFor({ state: 'hidden' });
      await chooseLayout(page, 'Files → Diff → Chat');
      await showFiles.press('Enter');
      await files.getByLabel('Filter files').and(page.locator(':focus')).waitFor();
      const chatText = chat.getByLabel('Ask about the diff');
      await chatText.fill('Does this line wrap?');
      for (const order of [
        'Diff → Chat → Files',
        'Files → Chat → Diff',
        'Chat → Files → Diff',
        'Diff → Files → Chat',
        'Chat → Diff → Files',
      ]) {
        await chooseLayout(page, order);
        assert.deepEqual(
          await paneOrder(page),
          order
            .toLowerCase()
            .split(' → ')
            .map((name) => 'review-' + name),
        );
      }
      assert.equal(await chatText.inputValue(), 'Does this line wrap?');
      const leftDivider = page.getByRole('separator', { name: 'Resize chat and diff' });
      const leftChatWidth = await chat.evaluate((el) => el.clientWidth);
      await leftDivider.press('ArrowRight');
      assert.ok((await chat.evaluate((el) => el.clientWidth)) > leftChatWidth);
      await leftDivider.press('ArrowLeft');
      await page.getByRole('button', { name: 'Close review chat' }).click();
      await page
        .getByRole('button', { name: 'Ask about PR' })
        .and(page.locator(':focus'))
        .waitFor();
      assert.equal(await chat.count(), 0);
      await region.getByRole('button', { name: 'Select new line 1', exact: true }).click();
      await region.getByRole('button', { name: 'Ask assistant', exact: true }).click();
      await chatText.and(page.locator(':focus')).waitFor();
      assert.equal(await chatText.inputValue(), 'Does this line wrap?');
      await chat.getByText(/line 1 \(new\)/).waitFor();
      await chooseLayout(page, 'Files → Diff → Chat');
      await chatText.fill('');
      await page.getByRole('button', { name: 'Review actions' }).click();
      await page.getByRole('menuitem', { name: 'Approve PR' }).click();
      const approval = page.getByRole('dialog', { name: 'Submit review to GitHub?' });
      await approval.getByRole('heading', { name: 'Approve', exact: true }).waitFor();
      await approval.getByRole('button', { name: 'Back to drafts' }).click();
      await page.getByLabel('Review decision').selectOption('COMMENT');
      await page.getByRole('button', { name: 'Save and close' }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      const railDivider = page.getByRole('separator', { name: 'Resize repository sidebar' });
      const sidebarWidth = await sidebar.evaluate((el) => el.clientWidth);
      await railDivider.press('ArrowRight');
      assert.ok((await sidebar.evaluate((el) => el.clientWidth)) > sidebarWidth);
      await railDivider.press('ArrowLeft');
      const chatDivider = page.getByRole('separator', { name: 'Resize diff and chat' });
      const chatBefore = await chat.evaluate((el) => el.clientWidth);
      await chatDivider.press('ArrowLeft');
      assert.ok((await chat.evaluate((el) => el.clientWidth)) > chatBefore);
      // Dragging the repository divider can give the reader a fractional width.
      const compactLimit = await page.addStyleTag({
        content: '#workspace-page { max-width: 680px !important; }',
      });
      await page.locator('#review-files[inert]').waitFor({ state: 'attached' });
      await compactLimit.evaluate((style) => {
        style.textContent = '#workspace-page { max-width: 680.25px !important; }';
      });
      await files.getByLabel('Filter files').waitFor();
      await compactLimit.evaluate((style) => style.remove());
      await chooseLayout(page, 'Chat → Diff → Files');
      await resize(app, page, 850, 720);
      await page.getByRole('button', { name: 'Close review chat' }).click();
      await showFiles.click();
      await files.getByLabel('Filter files').and(page.locator(':focus')).waitFor();
      await files.getByRole('button', { name: /^README\.md, added/ }).press('Enter');
      await showFiles.and(page.locator(':focus')).waitFor();
      await region.waitFor();
      await ask(page);
      await headerPicker.press('Enter');
      await page.getByRole('dialog', { name: 'Harness and model' }).waitFor();
      await page.keyboard.press('Escape');
      await headerPicker.and(page.locator(':focus-visible')).waitFor();
      await resize(app, page, 850, 440);
      await chat.getByLabel('Context', { exact: true }).selectOption('full-pr');
      await chat.getByLabel('Ask about the diff').fill('Keep my question');
      await chat.getByRole('button', { name: 'Send', exact: true }).scrollIntoViewIfNeeded();
      await chat.getByRole('button', { name: 'Send', exact: true }).click({ trial: true });
      assert.equal(await chatDivider.isVisible(), false);
      await page.getByRole('button', { name: 'Close review chat', exact: true }).click();
      await region.waitFor();
      await resize(app, page, 1380, 720);
      await ask(page);
      await chooseLayout(page, 'Files → Diff → Chat');
      await chatDivider.waitFor();
      assert.equal(await chat.getByLabel('Ask about the diff').inputValue(), 'Keep my question');
      await chat.getByLabel('Ask about the diff').fill('');

      await page.getByRole('button', { name: 'Select new line 1', exact: true }).click();
      await chat.getByRole('button', { name: 'Review instructions', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Review instructions', exact: true });
      await settings
        .getByLabel('Review prompt')
        .fill('Check the before and after behaviour with citations.');
      await settings.getByLabel('Save instructions for').selectOption('review');
      // React Aria gives a new overlay an inline opacity of 0 until it has finished entering,
      // so a screenshot taken straight after opening would be empty.
      await page.waitForFunction(
        () =>
          globalThis.getComputedStyle(globalThis.document.querySelector('.overlay')).opacity ===
          '1',
      );
      await capture(page, 'instructions');
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
      const sourcePicker = answer.getByRole('button', { name: '2 sources', exact: true });
      const centerOffsets = await sourcePicker.evaluate((button) => {
        function center(element) {
          const { top, height } = element.getBoundingClientRect();
          return top + height / 2;
        }
        return Array.from(button.children, (child) => Math.abs(center(child) - center(button)));
      });
      assert.equal(centerOffsets.length, 3);
      assert.ok(
        centerOffsets.every((offset) => offset <= 1),
        'Source icon, label and arrow align',
      );
      await sourcePicker.click();
      const citedLines = page.getByRole('dialog', { name: 'Cited lines' });
      await citedLines.getByRole('button', { name: /Open README\.md:1$/ }).waitFor();
      // An asynchronous refresh may finish while someone is choosing a citation.
      await page.evaluate(() =>
        globalThis.document.querySelector('.review-center .refresh').click(),
      );
      await page.waitForFunction(
        () => !globalThis.document.querySelector('.review-center .refresh').disabled,
      );
      await citedLines.getByRole('button', { name: /Open README\.md:1$/ }).waitFor();
      await page.keyboard.press('Escape');
      await sourcePicker.and(page.locator(':focus')).waitFor();
      await sourcePicker.press('Enter');
      const citedReaderLine = citedLines.getByRole('button', { name: /Open src\/reader\.ts:/ });
      const lineLabel = await citedReaderLine.innerText();
      await citedReaderLine.click();
      await citedLines.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: 'src/reader.ts', exact: true }).waitFor();
      const side = lineLabel.includes('(original)') ? 'old' : 'new';
      const line = Number(lineLabel.match(/:(\d+)/)[1]);
      await region
        .locator('.diff-line[data-selected=true][data-' + side + '-line="' + line + '"]')
        .waitFor();
      assert.equal(
        await answer
          .getByRole('button', { name: /^Open README\.md:1$/ })
          .first()
          .innerText(),
        'README.md:1',
      );
      const sources = answer.locator('details.answer-sources');
      await sources.getByText('Sources (2)', { exact: true }).click();
      assert.equal(await sources.locator('li').count(), 2);
      assert.match(await sources.locator('.source-location').first().innerText(), /README\.md:\d+/);
      await sources.locator('summary').click();
      if (preview) {
        await resize(app, page, 850, 720);
        await ask(page);
        await answer
          .getByRole('heading', { name: 'Review notes' })
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await capture(page, 'reading-narrow');
        await resize(app, page, 1380, 720);
      }
      await chat.locator('.cite').last().click();
      await page.getByRole('heading', { name: 'src/reader.ts', exact: true }).waitFor();
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
      const callerAnswer = chat
        .locator('.exchange')
        .filter({ hasText: 'Compare with the caller' })
        .last();
      await callerAnswer.getByRole('button', { name: 'Open callers.txt:500' }).click();
      const citedSource = page.getByRole('region', { name: 'Cited source' });
      await citedSource
        .locator('[data-selected=true][data-new-line="500"]')
        .getByText('fixture row 500')
        .waitFor();
      await citedSource.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.locator('.review-center .refresh').click();
      await page.waitForFunction(
        () => !globalThis.document.querySelector('.review-center .refresh').disabled,
      );
      assert.equal(await citedSource.evaluate((el) => el.scrollTop), 0);
      await callerAnswer.getByRole('button', { name: '2 sources' }).last().click();
      await page
        .getByRole('dialog', { name: 'Cited lines' })
        .getByRole('button', { name: 'Open partial.ts:850 (original)' })
        .click();
      await citedSource
        .locator('[data-selected=true][data-new-line="850"]')
        .getByText('fixture row 850')
        .waitFor();
      await page.getByRole('button', { name: 'Back to changes' }).click();
      await region.waitFor();
      await page.getByRole('heading', { name: 'src/reader.ts', exact: true }).waitFor();
      await chat.getByLabel('Context', { exact: true }).selectOption('focused');
      await chat.getByRole('button', { name: 'Review instructions', exact: true }).click();
      const promptDialog = page.getByRole('dialog', { name: 'Review instructions' });
      const existingReviewPrompt = await promptDialog.getByLabel(/^Review prompt/).inputValue();
      await promptDialog.getByLabel(/^Instructions for/).selectOption('summary');
      const customSummary = 'Summarise the behaviour and highlight the changed tests.';
      await promptDialog.getByLabel(/^Summary prompt/).fill(customSummary);
      await promptDialog.getByLabel(/^Save instructions for/).selectOption('review');
      await promptDialog.getByRole('button', { name: 'Save instructions', exact: true }).click();
      await promptDialog.getByText('Instructions saved.').waitFor();
      await promptDialog.getByLabel(/^Instructions for/).selectOption('review');
      assert.equal(
        await promptDialog.getByLabel(/^Review prompt/).inputValue(),
        existingReviewPrompt,
      );
      await promptDialog.getByRole('button', { name: 'Close', exact: true }).click();
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
      const summaryInstructions = await page.evaluate(async () => {
        const url = await globalThis.reviewer.activeReview();
        return (await globalThis.reviewer.history(url)).at(-1)?.settings.prompt;
      });
      assert.equal(summaryInstructions, customSummary);
      // The same summary and an approval can be started from the PR's row in the sidebar.
      const trackedRow = page.locator('.pr-queue .monitored-pr').filter({ hasText: 'Tracked PR' });
      await back(page);
      await trackedRow
        .getByRole('button', { name: 'Summarise pull request #12', exact: true })
        .click();
      await summary.nth(1).getByText('Read from the local PR copy.', { exact: true }).waitFor();
      // A new answer is scrolled into view.
      await page.waitForFunction(() => {
        const log = globalThis.document.querySelector('.chat-log');
        return log && log.scrollHeight - log.scrollTop - log.clientHeight < 4;
      });
      await back(page);
      assert.equal(await trackedRow.getAttribute('data-approved'), null);
      await trackedRow
        .getByRole('button', { name: 'Approve pull request #12', exact: true })
        .click();
      const decision = page.getByLabel('Review decision');
      assert.equal(await decision.inputValue(), 'APPROVE');
      await page.keyboard.press('Escape');
      await decision.waitFor({ state: 'hidden' });
      await ask(page);
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
      await back(page);
      await page.getByRole('heading', { name: 'Pull requests', exact: true }).waitFor();
      await working.waitFor();
      await capture(page, 'workspace-saved-reviews');
      await trackedRow.getByRole('button', { name: /Tracked PR/ }).click();
      await ask(page);
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
      await back(page);
      await page.getByRole('heading', { name: 'Pull requests', exact: true }).waitFor();
      await working.waitFor();
      await writeFile(releaseAnswer + '-away', '');
      await working.waitFor({ state: 'detached' });
      await trackedRow.getByRole('button', { name: /Tracked PR/ }).click();
      await ask(page);
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
        // GitHub only applies suggestions to updated lines.
        assert.equal(
          await page.getByRole('button', { name: 'Suggest change', exact: true }).isDisabled(),
          side === 'old',
        );
        await page.getByLabel('Comment', { exact: true }).fill(body);
        await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      }
      await page.getByRole('button', { name: 'Edit draft on old line 1' }).click();
      await page.getByLabel('Comment', { exact: true }).fill('Edited deletion note');
      await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      await page.getByRole('button', { name: 'Comment on line', exact: true }).click();
      await page.getByLabel('Comment', { exact: true }).fill('Discard this draft');
      await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      await page.getByRole('button', { name: /Finish review 3/ }).click();
      await page
        .locator('.draft-card')
        .filter({ hasText: 'Discard this draft' })
        .getByRole('button', { name: 'Discard' })
        .click();
      await page.getByLabel('Review summary').fill('Grouped review summary');
      await page.getByRole('button', { name: 'Save and close' }).click();
      // j moves to the next hunk, as Next hunk does, and focuses it for screen readers.
      await page.getByRole('dialog', { name: 'Review drafts' }).waitFor({ state: 'detached' });
      await page.keyboard.press('j');
      await region.getByText('+new line 60', { exact: true }).waitFor({ state: 'attached' });
      await page.waitForFunction(
        () => globalThis.document.activeElement?.getAttribute('aria-label') === 'File diff',
      );
      await page.getByRole('button', { name: 'Select new line 42', exact: true }).click();
      await page
        .getByRole('button', { name: 'Select new line 40', exact: true })
        .click({ modifiers: ['Shift'] });
      assert.equal(await region.locator('.diff-line[data-selected=true]').count(), 3);
      await page.getByRole('button', { name: 'Comment on lines 40–42' }).click();
      const inline = region.getByRole('form', { name: 'Draft line comment' });
      // Suggest change fills a fence with the selected new-side lines and keeps the caret inside.
      const suggest = inline.getByRole('button', { name: 'Suggest change', exact: true });
      await inline.getByLabel('Comment', { exact: true }).fill('Prefer this.');
      await suggest.focus();
      await page.keyboard.press('Enter');
      const field = await inline.getByLabel('Comment', { exact: true }).evaluate((el) => ({
        value: el.value,
        caret: el.selectionStart,
        focused: el === globalThis.document.activeElement,
      }));
      assert.ok(field.focused);
      assert.match(field.value, /^Prefer this\.\n\n```suggestion\n[^]+\n```$/);
      assert.equal(field.value.slice(field.caret), '\n```');
      await inline.getByRole('button', { name: 'Save draft' }).click();
      const figure = region.getByRole('figure', { name: 'Suggested change' });
      await figure.getByText('Original', { exact: true }).waitFor();
      await figure.getByText('Replacement', { exact: true }).waitFor();
      await region.getByText('Prefer this.', { exact: true }).waitFor();
      await region.getByRole('button', { name: 'Discard', exact: true }).click();
      await figure.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Comment on lines 40–42' }).click();
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
      await region.getByRole('button', { name: 'Ask assistant', exact: true }).click();
      await chat.getByText(/lines 40–42 \(new\)/).waitFor();
      await capture(page, 'inline-range');
      if (preview) {
        await resize(app, page, 1731, 909);
        await page.getByRole('button', { name: 'Review actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Approve PR' }).waitFor();
        await chat
          .locator('.chat-answer')
          .last()
          .getByRole('heading', { name: 'Review notes' })
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await capture(page, 'review-workspace');
        await page.keyboard.press('Escape');
        await resize(app, page, 1380, 720);
      }
      // A question saved with an older version still follows its hunk across a push.
      await page.evaluate(async (pr) => {
        const view = await globalThis.reviewer.cachedReview(pr);
        await globalThis.reviewer.pinQuestion({
          url: pr,
          revision: view.revision,
          path: 'src/reader.ts',
          hunk: 1,
          id: globalThis.crypto.randomUUID(),
          question: 'Could concurrent retries bypass this guard?',
        });
      }, url);
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
    if (!live) {
      assert.equal(
        await region.evaluate((el) => el.scrollTop),
        160,
        'checkpoint before reordering',
      );
      await chooseLayout(page, 'Chat → Diff → Files');
      assert.equal(await region.evaluate((el) => el.scrollTop), 160, 'checkpoint after reordering');
    }
  } finally {
    await app.close();
  }
  if (!live) await writeFile(join(directory, 'offline'), '');
  const reopened = await launch();
  try {
    const page = await reopened.firstWindow();
    page.setDefaultTimeout(15000);
    await resize(reopened, page, 1380, 720);
    if (!live) {
      await changedFiles(page).waitFor();
      await page.getByRole('region', { name: 'Review chat' }).waitFor();
      assert.deepEqual(await paneOrder(page), ['review-chat', 'review-diff', 'review-files']);
      const restoredDiff = page.getByRole('region', { name: 'File diff' });
      await restoredDiff.waitFor();
      assert.equal(
        await restoredDiff.evaluate((el) => el.scrollTop),
        160,
        'checkpoint after relaunch',
      );
      await chooseLayout(page, 'Files → Diff → Chat');
      assert.equal(
        await restoredDiff.evaluate((el) => el.scrollTop),
        160,
        'checkpoint after restoring layout',
      );
      await ask(page);
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
      assert.match(
        await region
          .locator('.code-line')
          .first()
          .evaluate((el) => globalThis.getComputedStyle(el).fontFamily),
        /^"Fira Code"/,
      );
      // The theme and font chosen in Settings survive the restart.
      await checkMacFrame(reopened, 'light');
      if (process.platform === 'darwin') {
        await page.locator('html.sidebar-vibrancy').waitFor();
        assert.equal(await page.evaluate(() => globalThis.reviewer.getSidebarVibrancy()), true);
      }
      assert.deepEqual(
        await page.evaluate(() => {
          const { palette, accent, font, codeFont } = globalThis.document.documentElement.dataset;
          return { palette, accent, font, codeFont };
        }),
        { palette: 'light', accent: 'green', font: 'humanist', codeFont: 'fira-code' },
      );
      await page
        .getByText(/claude · fixture-model.*Full PR/)
        .first()
        .waitFor();
      await page.getByRole('button', { name: 'example/project', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('region', { name: 'Review chat' }).locator('.exchange').count(),
        5,
      );
      await page.getByText('Hunk 2 of 2').waitFor();
      await page
        .getByRole('button', { name: 'Could concurrent retries bypass this guard?', exact: true })
        .waitFor();
      await page.getByRole('heading', { name: 'src/reader.ts', exact: true }).waitFor();
      await page.getByText(/Showing the saved revision/).waitFor();
      assert.equal(await region.evaluate((el) => el.scrollTop), 160);
      await page.getByRole('button', { name: /Finish review 3/ }).click();
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
      await back(page);
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
      assert.equal(await freshRow.getByText('Draft', { exact: true }).count(), 0);
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
      await approvedRow.getByRole('button', { name: /Tracked PR/ }).click();
      await ask(page);
      await page.getByRole('button', { name: 'Finish review', exact: true }).waitFor();
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
      const fullChat = page.getByRole('region', { name: 'Review chat' });
      const fullChatWidth = await fullChat.evaluate((el) => el.clientWidth);
      await page.getByRole('button', { name: 'Open update' }).click();
      const delta = page.getByRole('region', { name: 'Changes since checkpoint' });
      await delta.getByText('+guard retries', { exact: true }).waitFor();
      await fullChat.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Pipeline: Failed' }).click();
      const revisedPipeline = page.getByRole('dialog', { name: 'Pipeline' });
      await revisedPipeline
        .locator('.pipeline-job')
        .filter({ has: page.locator('summary').getByText('check', { exact: true }) })
        .getByRole('button', { name: 'Investigate failure' })
        .click();
      await revisedPipeline.getByText(/attempt 1 · job #911 · cccccccc/).waitFor();
      await revisedPipeline
        .getByRole('listitem')
        .filter({ hasText: 'Guard still permits the second retry.' })
        .getByRole('button', { name: 'Inspect code' })
        .click();
      await revisedPipeline
        .locator('[data-annotated=true]')
        .getByText('+guard retries', { exact: true })
        .waitFor();
      await revisedPipeline.getByRole('button', { name: 'Close', exact: true }).click();
      const queue = page.getByRole('navigation', { name: 'Re-review queue' });
      const folder = queue.getByRole('button', { name: 'src', exact: true });
      const readerFile = queue.getByRole('button', { name: /src\/reader.ts.*Needs another look/ });
      await readerFile.waitFor();
      await folder.click();
      await readerFile.waitFor({ state: 'hidden' });
      await queue.getByLabel('Filter files').fill('reader');
      await readerFile.waitFor();
      await queue.getByLabel('Filter files').fill('');
      await folder.click();

      await resize(reopened, page, 850, 720);
      await page.getByRole('button', { name: 'Show changed files' }).click();
      await readerFile.click();
      await delta.getByText('+guard retries', { exact: true }).waitFor();
      await resize(reopened, page, 1380, 720);
      await page.getByRole('button', { name: 'Full PR', exact: true }).click();
      assert.ok(Math.abs((await fullChat.evaluate((el) => el.clientWidth)) - fullChatWidth) < 3);
      await page.getByRole('button', { name: 'Since my last review' }).click();
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
      // A saved citation still opens its original revision after a push and restart.
      const savedAnswer = chat
        .locator('.exchange')
        .filter({ hasText: 'Compare with the caller' })
        .last();
      const savedCaller = savedAnswer.getByRole('button', { name: 'Open callers.txt:500' });
      await savedCaller.click();
      const snapshot = page.getByRole('region', { name: 'Cited source' });
      await snapshot.locator('[data-selected=true]').getByText('fixture row 500').waitFor();
      await page.getByRole('button', { name: 'Previous page' }).click();
      await snapshot.getByText('fixture row 1', { exact: true }).waitFor();
      await savedCaller.click();
      await snapshot.locator('[data-selected=true]').getByText('fixture row 500').waitFor();
      await page.getByRole('button', { name: 'Back to changes' }).click();
      const late = chat.locator('.exchange').filter({ hasText: 'Answer after the push' });
      await late.getByText(/Evidence needs another look/).waitFor();
      await late
        .getByRole('button', { name: /^Open src\/reader\.ts:/ })
        .first()
        .click();
      await late.getByText('Original hunk', { exact: true }).click();
      await late
        .locator('blockquote details pre')
        .filter({ hasText: /new line 1/ })
        .waitFor();
      const localPrompt = 'Read the caller before reviewing the update.';
      await fullChat.getByRole('button', { name: 'Review instructions' }).click();
      const instructions = page.getByRole('dialog', { name: 'Review instructions' });
      await instructions.getByLabel('Review prompt').fill(localPrompt);
      await instructions.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'Since my last review' }).click();
      await delta.waitFor();
      await page.getByRole('button', { name: 'Full PR', exact: true }).click();
      await fullChat.getByRole('button', { name: 'Review instructions' }).click();
      assert.equal(await instructions.getByLabel('Review prompt').inputValue(), localPrompt);
      await instructions.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: /Finish review 1/ }).click();
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
      await back(page);
      await page.getByRole('button', { name: 'Summarise pull request #12', exact: true }).click();
      await chat
        .locator('.exchange')
        .filter({ hasText: 'Summarise this whole pull request.' })
        .getByText(/dddddddd · Full PR/)
        .waitFor();
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
      await back(page);
      await page.getByRole('button', { name: 'Review pull request #12', exact: true }).click();
      const findings = page.getByRole('region', { name: 'Review findings' });
      await findings.getByText('Retry loses its update', { exact: true }).waitFor();
      const messageOrder = await page.locator('.exchange .chat-question').allTextContents();
      const rejected = findings.getByLabel('Validation for Unconfirmed caller');
      await rejected.selectOption('dismissed');
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector('[aria-label="Validation for Unconfirmed caller"]')
            ?.value === 'dismissed',
      );
      await findings.getByLabel('Validation for Retry loses its update').selectOption('valid');
      await findings.getByRole('button', { name: 'Add 1 draft comment' }).click();
      await findings.getByText('Added to drafts').waitFor();
      assert.deepEqual(
        await page.locator('.exchange .chat-question').allTextContents(),
        messageOrder,
      );
      const composer = chat.getByRole('textbox', { name: 'Ask about the diff' });
      await composer.fill('Unsent question');
      await chat.getByRole('button', { name: 'New conversation' }).click();
      const earlier = chat.getByText('Earlier messages', { exact: true });
      await earlier.waitFor();
      assert.equal(await composer.inputValue(), '');
      assert.equal(await chat.locator('.exchange:visible').count(), 0);
      await earlier.click();
      await findings.getByText('Added to drafts').waitFor();
      await earlier.click();
      await composer.fill('Check fresh conversation context');
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await chat.getByText('Prior exchanges received: 0', { exact: true }).waitFor();
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
      await page.getByRole('status').filter({ hasText: '3 new review alerts' }).waitFor();
      await page.getByRole('button', { name: 'Review alerts, 3 unread', expanded: false }).click();
      const inbox = page.getByRole('region', { name: 'Review alerts' });
      await page.getByRole('button', { name: /^Review alerts,/, expanded: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await inbox.getByText('Added coverage for concurrent retries.', { exact: true }).waitFor();
      await inbox.getByText('New push after your review', { exact: true }).waitFor();
      await inbox.getByText('Your review was dismissed', { exact: true }).waitFor();
      await capture(page, 'reply-inbox');
      await inbox.getByRole('button', { name: 'Mark all read' }).click();
      await inbox.getByText('@fixture-reviewer · 0 unread', { exact: true }).waitFor();
      await inbox.getByRole('button', { name: 'Close review alerts' }).click();
      await page
        .getByRole('button', { name: /^Review alerts,/, expanded: false })
        .and(page.locator(':focus'))
        .waitFor();
      await writeFile(repliesFile, '[]');
      await writeFile(switchedAccount, '');
      await page.getByRole('button', { name: /^Review alerts,/ }).click();
      await inbox.getByText('Checking for alerts…').waitFor();
      assert.equal(await inbox.getByText('Added coverage for concurrent retries.').count(), 0);
      await inbox.getByText('@second-reviewer · 0 unread', { exact: true }).waitFor();
      assert.equal(await inbox.getByText('Added coverage for concurrent retries.').count(), 0);
      await inbox.getByRole('button', { name: 'Close review alerts' }).click();
      await page
        .getByRole('button', { name: /^Review alerts,/, expanded: false })
        .and(page.locator(':focus'))
        .waitFor();
    }
    await back(page);
    await page.getByRole('heading', { name: 'Pull requests', exact: true }).waitFor();
    if (!live) {
      await page.getByRole('button', { name: /Tracked PR.*Draft/ }).waitFor();
      // Opening the new pull request clears its highlight and the count on the app icon.
      const freshRow = page.locator('.monitored-pr[data-new]');
      await freshRow.getByRole('button', { name: /Fresh PR/ }).click();
      await freshRow.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: /^src\/reader\.ts, modified/ }).click();
      const reminder = page.getByRole('region', { name: 'Review lessons for these changes' });
      await reminder.getByText('Check the callers before changing this behaviour.').waitFor();
      await reminder.getByRole('button', { name: 'Source discussion · PR #12' }).waitFor();
      await page.getByRole('button', { name: 'Next hunk' }).click();
      assert.equal(await reminder.count(), 0);
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      const library = page.getByRole('region', { name: 'Repository review lessons' });
      await library.getByRole('button', { name: 'Forget lesson' }).click();
      await library.waitFor({ state: 'detached' });
      if (process.platform !== 'win32')
        assert.equal(await reopened.evaluate(({ app }) => app.getBadgeCount()), 0);
      assert.deepEqual(await reopened.evaluate(() => globalThis.shownAlerts), [
        'New pull request in example/project|#14 Fresh PR\n@octo',
        'example/project #12|Your review was dismissed · New push after your review',
      ]);

      // A saved PR must leave both open lists even while the monitored response still lists it.
      const mergedSidebar = page
        .getByRole('navigation', { name: 'Repositories', exact: true })
        .getByRole('link', { name: '#14', exact: true });
      await mergedSidebar.waitFor();
      await writeFile(join(directory, 'merged-14'), '');
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await mergedSidebar.waitFor({ state: 'hidden' });
      await back(page);
      await page.getByRole('button', { name: /Tracked PR.*Draft/ }).waitFor();
      assert.equal(await page.getByRole('link', { name: '#14', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Open review', exact: true }).click();
      await page
        .getByLabel('GitHub pull request URL')
        .fill('https://github.com/example/project/pull/14');
      await page.getByRole('button', { name: 'Save pull request' }).click();
      await changedFiles(page).waitFor();
      await back(page);
      await page.getByRole('button', { name: /Tracked PR.*Draft/ }).waitFor();
      assert.equal(await page.getByRole('link', { name: '#14', exact: true }).count(), 0);
      // Local branch reviews use the same picker and return to their own repository queue.
      await reopened.evaluate(
        ({ dialog }, source) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
        },
        join(directory, 'source'),
      );
      await page.getByRole('button', { name: 'Open review', exact: true }).click();
      await page.getByRole('button', { name: 'Review local branch', exact: true }).click();
      const localDialog = page.getByRole('dialog', { name: 'Review local branch' });
      await localDialog.getByLabel('Base branch').selectOption({ label: 'pair-21' });
      await localDialog.getByRole('button', { name: 'Start review' }).click();
      await changedFiles(page).waitFor();
      await page.getByRole('button', { name: 'Ask about branch' }).waitFor();
      assert.equal(await page.getByRole('region', { name: 'Review chat' }).count(), 0);
      // Single-key shortcuts work in a local review: j reports the last hunk, v marks the file
      // reviewed, c opens the comment editor, and Esc closes it and returns focus to the hunk.
      const shortcutDiff = page.getByRole('region', { name: 'File diff' });
      await shortcutDiff.waitFor();
      const shortcutStatus = page.getByRole('status').filter({ hasText: 'This is the last hunk.' });
      await page.keyboard.press('j');
      await shortcutStatus.first().waitFor({ state: 'attached' });
      const markReviewed = page.getByRole('button', { name: /^(Mark reviewed|Reviewed ✓)$/ });
      const wasReviewed = (await markReviewed.textContent())?.includes('✓') ?? false;
      await page.keyboard.press('v');
      await page
        .getByRole('button', { name: wasReviewed ? 'Mark reviewed' : 'Reviewed ✓', exact: true })
        .waitFor();
      await page.keyboard.press('v');
      await page
        .getByRole('button', { name: wasReviewed ? 'Reviewed ✓' : 'Mark reviewed', exact: true })
        .waitFor();
      await page.keyboard.press('c');
      const shortcutEditor = shortcutDiff.getByRole('form', { name: 'Draft line comment' });
      await shortcutEditor.waitFor();
      // Typing in the editor never triggers a shortcut.
      await page.keyboard.type('jkvc?');
      assert.equal(
        await shortcutEditor.getByLabel('Comment', { exact: true }).inputValue(),
        'jkvc?',
      );
      assert.equal(await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).count(), 0);
      await page.keyboard.press('Escape');
      await shortcutEditor.getByText('Press Esc again to discard this comment.').waitFor();
      await page.keyboard.press('Escape');
      await shortcutEditor.waitFor({ state: 'detached' });
      await page.waitForFunction(() => {
        const active = globalThis.document.activeElement;
        return (
          !!active?.getAttribute('aria-label')?.startsWith('Select ') &&
          !!active.closest('.diff-scroll')
        );
      });
      // ? lists the shortcuts, and nothing else reacts while the dialog is open.
      await page.keyboard.press('Shift+Slash');
      const shortcutDialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
      await shortcutDialog.waitFor();
      await page.keyboard.press('v');
      await page.keyboard.press('Escape');
      await shortcutDialog.waitFor({ state: 'detached' });
      await page
        .getByRole('button', { name: wasReviewed ? 'Reviewed ✓' : 'Mark reviewed', exact: true })
        .waitFor();
      assert.equal(await page.getByRole('region', { name: 'Review chat' }).count(), 0);
      await page.getByRole('button', { name: 'Local reviews', exact: true }).click();
      await page.getByRole('heading', { name: 'Local reviews', exact: true }).waitFor();
      await page
        .getByRole('region', { name: 'Saved reviews' })
        .getByRole('button', { name: /pair-21/ })
        .waitFor();
      const otherPr = 'https://github.com/another/project/pull/88';
      await page.getByRole('button', { name: 'Open review', exact: true }).click();
      await page.getByLabel('GitHub pull request URL').fill(otherPr);
      await page.getByRole('button', { name: 'Save pull request' }).click();
      const savedQueue = page.getByRole('main');
      assert.equal(
        await savedQueue.getByRole('link', { name: '#88', exact: true }).getAttribute('href'),
        otherPr,
      );
      await savedQueue.getByRole('button', { name: /#88.*another\/project/ }).waitFor();
      assert.equal(await savedQueue.getByRole('button', { name: /Tracked PR/ }).count(), 0);
      await page.getByRole('button', { name: 'example/project', exact: true }).click();
      await savedQueue.getByRole('button', { name: /Tracked PR/ }).waitFor();
      assert.equal(await savedQueue.getByRole('button', { name: /#88/ }).count(), 0);

      // A longer folder previews five reviews. A PR opened from its queue stays visible.
      for (let number = 89; number <= 94; number++) {
        await page.getByRole('button', { name: 'Open review', exact: true }).click();
        await page
          .getByLabel('GitHub pull request URL')
          .fill('https://github.com/another/project/pull/' + number);
        await page.getByRole('button', { name: 'Save pull request' }).click();
        await savedQueue.getByRole('button', { name: '#' + number + ' another/project' }).waitFor();
      }
      const otherFolder = page.getByRole('list', { name: 'Reviews in another/project' });
      const more = otherFolder.getByRole('button', { name: 'Show more', exact: true });
      await more.waitFor();
      assert.equal(await otherFolder.locator('.sidebar-review').count(), 5);
      await otherFolder
        .locator('.sidebar-review-meta')
        .filter({ hasText: / · Saved / })
        .first()
        .waitFor();
      const previewNames = await otherFolder.locator('.sidebar-review-meta a').allTextContents();
      await more.click();
      assert.equal(await otherFolder.locator('.sidebar-review').count(), 7);
      await resize(reopened, page, 850, 440);
      const scrollArea = page.locator('.repository-navigation > .sidebar-contents:visible');
      const fixedGear = page
        .getByRole('navigation', { name: 'Workspace tools' })
        .getByRole('button', { name: 'Settings' });
      const beforeScroll = await fixedGear.boundingBox();
      assert.ok(
        await scrollArea.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          return el.scrollTop > 0;
        }),
      );
      assert.deepEqual(await fixedGear.boundingBox(), beforeScroll);
      await resize(reopened, page, 1380, 720);
      const outsidePreview = (
        await otherFolder.locator('.sidebar-review-meta a').allTextContents()
      ).find((name) => !previewNames.includes(name));
      assert.ok(outsidePreview);
      const number = outsidePreview.split('#').at(-1);
      await otherFolder.getByRole('button', { name: 'Show less' }).click();
      await savedQueue.getByRole('button', { name: '#' + number + ' another/project' }).click();
      await otherFolder.locator('[aria-current="page"]').waitFor();
      assert.match(
        await otherFolder.locator('[aria-current="page"]').getAttribute('aria-label'),
        new RegExp('#' + number + '(?: |$)'),
      );
      await capture(page, 'sidebar-folders');
      await back(page);

      // Saved reviews remain usable when repository monitoring is unavailable at startup.
      await reopened.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('repos:list');
        ipcMain.handle('repos:list', () => {
          throw Error('Fixture repository read failed');
        });
      });
      await page.reload();
      await page.getByRole('alert').filter({ hasText: 'Fixture repository read failed' }).waitFor();
      await page.getByRole('button', { name: 'another/project', exact: true }).click();
      await savedQueue.getByRole('button', { name: /#88.*another\/project/ }).waitFor();
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
