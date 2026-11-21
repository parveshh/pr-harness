import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRequest, Turn } from '../shared/assistant.js';
import { createChatRuns } from '../shared/chat-runs.js';

const prA = 'https://github.com/example/project/pull/1',
  prB = 'https://github.com/example/project/pull/2';
const request = (url: string, run: string, question: string): ChatRequest => ({
  run,
  url,
  revision: 'base...head',
  path: 'f.ts',
  hunk: 0,
  selection: null,
  extra: null,
  question,
});
function harness() {
  const pending = new Map<string, { resolve: (turn: Turn) => void; reject: (e: Error) => void }>();
  const cancels: string[] = [];
  let activity: (event: { run: string; text: string }) => void = () => {};
  const runs = createChatRuns(
    {
      ask: (req) => new Promise((resolve, reject) => pending.set(req.run, { resolve, reject })),
      cancelAsk: (run) => {
        cancels.push(run);
        return Promise.resolve();
      },
      onActivity: (callback) => {
        activity = callback;
        return () => {};
      },
    },
    () => 1000,
  );
  const answer = (req: ChatRequest): Turn => ({
    run: req.run,
    revision: req.revision,
    path: req.path,
    question: req.question,
    answer: 'Answer to ' + req.question,
    citations: [],
    settings: { agent: 'claude', model: '', provider: 'default', prompt: 'p' },
    promptVersion: 'v',
    reportedModel: null,
  });
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  return {
    runs,
    pending,
    cancels,
    answer,
    settled,
    emit: (e: { run: string; text: string }) => activity(e),
  };
}
const first = '11111111-1111-4111-8111-111111111111',
  second = '22222222-2222-4222-8222-222222222222',
  third = '33333333-3333-4333-8333-333333333333';

await test('each PR keeps its own run, progress, answers and draft', async () => {
  const { runs, pending, answer, settled, emit } = harness();
  let changes = 0;
  runs.subscribe(() => changes++);
  runs.setDraft(prA, 'Why retry?');
  runs.setDraft(prB, 'Unrelated draft');
  const a = request(prA, first, 'Why retry?'),
    b = request(prB, second, 'Summarise');
  assert.equal(runs.start(a, 'question', { clearDraft: true }), true);
  assert.equal(runs.start(b, 'summary'), true);
  // A PR runs one answer at a time.
  assert.equal(runs.start(request(prA, third, 'Again'), 'question'), false);
  await settled();
  emit({ run: second, text: 'Reading files' });
  emit({ run: 'unknown', text: 'Ignored' });
  assert.deepEqual(runs.get(prB).active, {
    run: second,
    kind: 'summary',
    question: 'Summarise',
    contextMode: 'focused',
    partial: 'Reading files',
    startedAt: 1000,
  });
  assert.equal(runs.get(prA).active?.partial, '');
  assert.deepEqual(
    [...runs.working()],
    [
      [prA, 'question'],
      [prB, 'summary'],
    ],
  );
  // Streamed text and drafts do not disturb the list of PRs with a run.
  const before = runs.working();
  emit({ run: second, text: 'Reading more files' });
  runs.setDraft(prB, 'Another draft');
  assert.equal(runs.working(), before);
  pending.get(first)?.resolve(answer(a));
  await settled();
  assert.deepEqual([...runs.working()], [[prB, 'summary']]);
  assert.equal(runs.get(prA).active, null);
  assert.deepEqual(
    runs.get(prA).completed.map((t) => t.answer),
    ['Answer to Why retry?'],
  );
  // The answered question leaves the composer. The other PR is untouched.
  assert.equal(runs.get(prA).draft, '');
  assert.equal(runs.get(prB).draft, 'Another draft');
  assert.equal(runs.get(prB).active?.run, second);
  assert.equal(runs.get(prB).completed.length, 0);
  assert.ok(changes > 0);
});

await test('a failed or cancelled run reports on its own PR and frees it for another run', async () => {
  const { runs, pending, cancels, settled, answer } = harness();
  const a = request(prA, first, 'Explain');
  runs.setDraft(prA, 'Explain');
  runs.start(a, 'question', { clearDraft: true });
  await settled();
  runs.cancel(prA);
  assert.deepEqual(cancels, [first]);
  pending
    .get(first)
    ?.reject(new Error("Error invoking remote method 'chat:ask': Error: Review cancelled."));
  await settled();
  assert.deepEqual(
    { ...runs.get(prA), completed: runs.get(prA).completed.length },
    { active: null, completed: 0, error: 'Review cancelled.', draft: 'Explain' },
  );
  assert.equal(runs.get(prB).error, '');
  // Starting again clears the error.
  const again = request(prA, second, 'Explain');
  assert.equal(runs.start(again, 'question'), true);
  assert.equal(runs.get(prA).error, '');
  await settled();
  pending.get(second)?.resolve(answer(again));
  await settled();
  assert.equal(runs.get(prA).completed.length, 1);
});

await test('work before asking can fail or be cancelled without calling the agent', async () => {
  const { runs, pending, settled } = harness();
  runs.start(request(prA, first, 'Explain'), 'question', {
    before: () => Promise.reject(new Error('Could not save instructions.')),
  });
  await settled();
  assert.equal(runs.get(prA).error, 'Could not save instructions.');
  let release: () => void = () => {};
  runs.start(request(prA, second, 'Explain'), 'question', {
    before: () => new Promise<void>((resolve) => (release = resolve)),
  });
  runs.cancel(prA);
  release();
  await settled();
  assert.equal(runs.get(prA).error, 'Review cancelled.');
  assert.equal(pending.size, 0);
});
